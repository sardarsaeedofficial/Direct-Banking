import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Phase 4 integration tests (categorisation, insights, budgets, subscriptions,
// net worth, safe-to-spend, activity). Opt-in: set MOBILE_TEST_DATABASE_URL to a
// reachable Postgres. Unset → the suite skips so the unit gate stays green.

let ready = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let svc: any;
const EMAIL_TAG = "p4test+";

beforeAll(async () => {
  const dbUrl = process.env.MOBILE_TEST_DATABASE_URL;
  if (!dbUrl) { ready = false; return; }
  process.env.DATABASE_URL = dbUrl;
  process.env.MOBILE_JWT_SECRET ||= "test-mobile-secret-0123456789abcdef";
  process.env.SESSION_SECRET ||= "test-session-secret-0123456789abcdef";
  try {
    const db = await import("../db.js");
    prisma = db.prisma;
    await prisma.$queryRaw`SELECT 1`;
    svc = {
      users: await import("./users.service.js"),
      txns: await import("./transactions.service.js"),
      cat: await import("./categorization.service.js"),
      insights: await import("./insights.service.js"),
      budgets: await import("./budgets.service.js"),
      recurring: await import("./recurring.service.js"),
      merchant: await import("./merchant-intelligence.service.js"),
      cashflow: await import("./cashflow.service.js"),
    };
    ready = true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[phase4.test] setup failed, skipping:", e);
    ready = false;
  }
});

afterAll(async () => {
  if (ready && prisma) await prisma.user.deleteMany({ where: { email: { contains: EMAIL_TAG } } });
});

let seq = 0;
async function newUser() {
  const user = await svc.users.registerUser({ email: `${EMAIL_TAG}${Date.now()}_${seq++}@example.com`, password: "password1234" });
  return user;
}
async function catId(userId: string, code: string): Promise<string> {
  const c = await prisma.category.findFirst({ where: { userId, code } });
  return c.id;
}
async function account(userId: string, accountType = "CURRENT", balanceMinor = 0, currency = "GBP") {
  return prisma.bankAccount.create({ data: { userId, bankName: "Test Bank", nickname: `${accountType} acct`, accountType, balanceMinor: BigInt(balanceMinor), currency } });
}
interface TxOpts {
  direction: "INCOME" | "EXPENSE" | "TRANSFER";
  amountMinor: number;
  description: string;
  merchantName?: string;
  bookedAt?: Date;
  status?: "COMPLETED" | "PENDING" | "CANCELLED";
  transferAccountId?: string;
  transactionType?: string;
  categoryId?: string;
  applyBalance?: boolean;
}
async function addTxn(userId: string, accountId: string, o: TxOpts) {
  return svc.txns.createTransaction(userId, {
    accountId, direction: o.direction, amountMinor: o.amountMinor, description: o.description,
    merchantName: o.merchantName, bookedAt: o.bookedAt ?? new Date(), status: o.status,
    transferAccountId: o.transferAccountId, transactionType: o.transactionType as never,
    categoryId: o.categoryId, applyBalance: o.applyBalance,
  });
}
function codeOf(txn: { category?: { code?: string | null } | null }): string | null {
  return txn.category?.code ?? null;
}

describe("Phase 4 — categorisation", () => {
  it("maps Tesco to Groceries, Shell to Fuel, Netflix to Subscriptions", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id);
    const tesco = await addTxn(u.id, a.id, { direction: "EXPENSE", amountMinor: 4200, description: "TESCO STORES 1234", merchantName: "TESCO STORES 1234" });
    const shell = await addTxn(u.id, a.id, { direction: "EXPENSE", amountMinor: 6000, description: "SHELL LONDON", merchantName: "SHELL" });
    const netflix = await addTxn(u.id, a.id, { direction: "EXPENSE", amountMinor: 1099, description: "NETFLIX.COM", merchantName: "Netflix" });
    expect(codeOf(tesco)).toBe("GROCERIES");
    expect(codeOf(shell)).toBe("FUEL");
    expect(codeOf(netflix)).toBe("SUBSCRIPTIONS");
  });

  it("falls back to Other for an unrecognised merchant", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id);
    const t = await addTxn(u.id, a.id, { direction: "EXPENSE", amountMinor: 500, description: "ACME CORNER SHOP", merchantName: "ACME CORNER SHOP" });
    expect(codeOf(t)).toBe("OTHER");
  });

  it("applies a user rule ahead of the heuristic", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id);
    const health = await catId(u.id, "HEALTH");
    await prisma.categoryRule.create({ data: { userId: u.id, field: "DESCRIPTION", operator: "CONTAINS", value: "gymbox", categoryId: health } });
    const t = await addTxn(u.id, a.id, { direction: "EXPENSE", amountMinor: 3000, description: "GYMBOX LONDON", merchantName: "Gymbox" });
    expect(codeOf(t)).toBe("HEALTH");
  });

  it("learns from a user correction for future transactions", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id);
    const first = await addTxn(u.id, a.id, { direction: "EXPENSE", amountMinor: 800, description: "ZORP DELI", merchantName: "ZORP DELI" });
    expect(codeOf(first)).toBe("OTHER");
    const groceries = await catId(u.id, "GROCERIES");
    await svc.cat.teachMerchantCategory(u.id, first.merchantId, groceries);
    const second = await addTxn(u.id, a.id, { direction: "EXPENSE", amountMinor: 900, description: "ZORP DELI", merchantName: "ZORP DELI" });
    expect(codeOf(second)).toBe("GROCERIES");
  });
});

describe("Phase 4 — insights", () => {
  it("computes income/spending/net and savings rate, excluding transfers and cancelled", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id);
    const b = await account(u.id, "SAVINGS");
    await addTxn(u.id, a.id, { direction: "INCOME", amountMinor: 200000, description: "ACME PAYROLL", merchantName: "Acme Payroll" });
    await addTxn(u.id, a.id, { direction: "EXPENSE", amountMinor: 50000, description: "TESCO", merchantName: "Tesco" });
    // Own-account transfer to savings — must not count as spending or income.
    await addTxn(u.id, a.id, { direction: "EXPENSE", amountMinor: 30000, description: "To savings", transferAccountId: b.id, transactionType: "TRANSFER" });
    // Cancelled expense — excluded.
    await addTxn(u.id, a.id, { direction: "EXPENSE", amountMinor: 99999, description: "VOID", status: "CANCELLED" });

    const summary = await svc.insights.monthlySummary(u.id, "UTC");
    const gbp = summary.currencies.find((c: any) => c.currency === "GBP");
    expect(gbp.incomeMinor).toBe(200000);
    expect(gbp.spendingMinor).toBe(50000);
    expect(gbp.netMinor).toBe(150000);
    // Savings rate = 150000/200000 = 75% → 7500 bps.
    expect(gbp.savingsRateBps).toBe(7500);
  });

  it("never combines currencies in the summary", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const gbp = await account(u.id, "CURRENT", 0, "GBP");
    const eur = await account(u.id, "CURRENT", 0, "EUR");
    await addTxn(u.id, gbp.id, { direction: "EXPENSE", amountMinor: 1000, description: "Tesco", merchantName: "Tesco" });
    await prisma.transaction.create({ data: { userId: u.id, accountId: eur.id, direction: "EXPENSE", amountMinor: 2000n, currency: "EUR", bookedAt: new Date(), description: "Carrefour" } });
    const summary = await svc.insights.monthlySummary(u.id, "UTC");
    const codes = summary.currencies.map((c: any) => c.currency).sort();
    expect(codes).toContain("GBP");
    expect(codes).toContain("EUR");
    const eurRow = summary.currencies.find((c: any) => c.currency === "EUR");
    expect(eurRow.spendingMinor).toBe(2000);
  });

  it("returns a safe null change% when the previous period was zero", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id);
    await addTxn(u.id, a.id, { direction: "EXPENSE", amountMinor: 5000, description: "Tesco", merchantName: "Tesco" });
    const cmp = await svc.insights.periodComparison(u.id, "UTC", "month");
    const gbp = cmp.comparisons.find((c: any) => c.currency === "GBP");
    expect(gbp.spending.changePct).toBeNull(); // previous month had no spending
    expect(gbp.spending.currentMinor).toBe(5000);
  });

  it("classifies net worth by account type, per currency", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    await account(u.id, "CURRENT", 100000);
    await account(u.id, "SAVINGS", 50000);
    await account(u.id, "CREDIT_CARD", -20000);
    const nw = await svc.insights.netWorth(u.id);
    const gbp = nw.currencies.find((c: any) => c.currency === "GBP");
    expect(gbp.assetsMinor).toBe(150000);
    expect(gbp.liabilitiesMinor).toBe(-20000);
    expect(gbp.netWorthMinor).toBe(130000);
  });
});

describe("Phase 4 — budgets", () => {
  it("tracks spend, remaining and OVER_BUDGET, and de-duplicates alerts", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id);
    const groceries = await catId(u.id, "GROCERIES");
    await prisma.budget.create({ data: { userId: u.id, name: "Food", categoryId: groceries, limitMinor: 10000n, currency: "GBP", startDate: new Date() } });
    await addTxn(u.id, a.id, { direction: "EXPENSE", amountMinor: 6000, description: "TESCO", merchantName: "Tesco" });

    let prog = (await svc.budgets.budgetProgress(u.id, "UTC"))[0];
    expect(prog.spentMinor).toBe(6000);
    expect(prog.remainingMinor).toBe(4000);
    expect(prog.status).toBe("ON_TRACK");

    // First alert evaluation crosses 50%.
    const first = await svc.budgets.evaluateBudgetAlerts(u.id, "UTC");
    expect(first.map((a: any) => a.threshold)).toContain(50);
    // Re-evaluating without new spend must not re-fire the same threshold.
    const second = await svc.budgets.evaluateBudgetAlerts(u.id, "UTC");
    expect(second.length).toBe(0);

    // Push over the limit.
    await addTxn(u.id, a.id, { direction: "EXPENSE", amountMinor: 5000, description: "TESCO", merchantName: "Tesco" });
    prog = (await svc.budgets.budgetProgress(u.id, "UTC"))[0];
    expect(prog.status).toBe("OVER_BUDGET");
    expect(prog.remainingMinor).toBeLessThan(0);
  });
});

describe("Phase 4 — recurring / subscriptions", () => {
  it("detects a monthly card subscription but not an unrelated one-off, and never a Direct Debit", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id);
    // Four monthly Netflix card charges.
    for (let i = 4; i >= 1; i--) {
      await addTxn(u.id, a.id, { direction: "EXPENSE", amountMinor: 1099, description: "NETFLIX.COM", merchantName: "Netflix", bookedAt: new Date(Date.now() - i * 30 * 86400000) });
    }
    // A single unrelated one-off.
    await addTxn(u.id, a.id, { direction: "EXPENSE", amountMinor: 4200, description: "TESCO", merchantName: "Tesco" });
    // A Direct-Debit-flagged mandate payment (must be ignored by subscription detection).
    const dd = await prisma.directDebitMandate.create({ data: { userId: u.id, accountId: a.id, companyName: "British Gas", normalizedCompanyName: "british gas", kind: "DIRECT_DEBIT", status: "ACTIVE", firstSeenAt: new Date() } });
    for (let i = 3; i >= 1; i--) {
      const t = await addTxn(u.id, a.id, { direction: "EXPENSE", amountMinor: 8000, description: "BRITISH GAS DD", merchantName: "British Gas", bookedAt: new Date(Date.now() - i * 30 * 86400000) });
      await prisma.transaction.update({ where: { id: t.id }, data: { directDebitMandateId: dd.id, transactionType: "DIRECT_DEBIT", recurringKind: "DIRECT_DEBIT" } });
    }

    const subs = await svc.recurring.detectSubscriptions(u.id);
    const netflix = subs.find((s: any) => s.merchantName.toLowerCase().includes("netflix"));
    expect(netflix).toBeTruthy();
    expect(["CONFIRMED", "HIGH_CONFIDENCE"]).toContain(netflix.confidence);
    expect(netflix.kind).toBe("SUBSCRIPTION");
    // Tesco (one-off) is not suggested.
    expect(subs.find((s: any) => s.merchantName.toLowerCase().includes("tesco"))).toBeUndefined();
    // British Gas (a Direct Debit) is never reclassified as a subscription.
    expect(subs.find((s: any) => s.merchantName.toLowerCase().includes("british gas"))).toBeUndefined();
  });

  it("presents a combined recurring-payments view with monthly/annual totals", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id);
    await prisma.directDebitMandate.create({ data: { userId: u.id, accountId: a.id, companyName: "Spotify", normalizedCompanyName: "spotify", kind: "SUBSCRIPTION", status: "ACTIVE", frequency: "MONTHLY", expectedAmountMinor: 999, firstSeenAt: new Date() } });
    const view = await svc.recurring.recurringPaymentsView(u.id);
    expect(view.activeCount).toBe(1);
    expect(view.monthlyTotalMinor).toBe(999);
    expect(view.annualTotalMinor).toBe(999 * 12);
    expect(view.byKind.SUBSCRIPTION.length).toBe(1);
  });
});

describe("Phase 4 — merchant intelligence, safe-to-spend, activity, ownership", () => {
  it("builds a merchant profile and enforces ownership", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const other = await newUser();
    const a = await account(u.id);
    const t1 = await addTxn(u.id, a.id, { direction: "EXPENSE", amountMinor: 4200, description: "TESCO", merchantName: "Tesco" });
    await addTxn(u.id, a.id, { direction: "EXPENSE", amountMinor: 5800, description: "TESCO", merchantName: "Tesco" });
    const profile = await svc.merchant.merchantProfile(u.id, t1.merchantId, "UTC");
    expect(profile.txnCount).toBe(2);
    expect(profile.totalSpentMinor).toBe(10000);
    expect(profile.averageMinor).toBe(5000);
    expect(profile.highestMinor).toBe(5800);
    // Another user cannot read this merchant's profile.
    expect(await svc.merchant.merchantProfile(other.id, t1.merchantId, "UTC")).toBeNull();
  });

  it("computes safe-to-spend from available balance minus upcoming and reserve", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id, "CURRENT", 100000);
    // An upcoming subscription mandate due in 5 days.
    await prisma.directDebitMandate.create({ data: { userId: u.id, accountId: a.id, companyName: "Spotify", normalizedCompanyName: "spotify", kind: "SUBSCRIPTION", status: "ACTIVE", expectedAmountMinor: 1000, nextExpectedAt: new Date(Date.now() + 5 * 86400000), firstSeenAt: new Date() } });
    const s = await svc.cashflow.safeToSpend(u.id, 20000);
    expect(s.availableMinor).toBe(100000);
    expect(s.upcomingCommittedMinor).toBe(1000);
    expect(s.minReserveMinor).toBe(20000);
    expect(s.safeToSpendMinor).toBe(79000);
    expect(s.label).toBe("Estimate");
  });
});
