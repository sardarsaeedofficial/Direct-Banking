import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Phase 6 — financial integrity regression tests for the production-readiness
// audit (see docs/PHASE6_AUDIT.md). Opt-in: set MOBILE_TEST_DATABASE_URL to a
// reachable Postgres, else the suite skips so the unit gate stays green.

let ready = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let svc: any;
const EMAIL_TAG = "p6test+";

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
      notif: await import("./notification-import.service.js"),
      csv: await import("./csv-import.service.js"),
      reports: await import("./reports.service.js"),
      direct: await import("./direct-debit.service.js"),
      recurring: await import("./recurring.service.js"),
      insights: await import("./insights.service.js"),
      corrections: await import("./corrections.service.js"),
      review: await import("./review.service.js"),
    };
    ready = true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[phase6.test] setup failed, skipping:", e);
    ready = false;
  }
});

afterAll(async () => {
  if (ready && prisma) await prisma.user.deleteMany({ where: { email: { contains: EMAIL_TAG } } });
});

let seq = 0;
async function newUser() {
  return svc.users.registerUser({ email: `${EMAIL_TAG}${Date.now()}_${seq++}@example.com`, password: "password1234" });
}
async function account(userId: string, extra: Record<string, unknown> = {}) {
  return prisma.bankAccount.create({ data: { userId, bankName: "Test Bank", nickname: "Acct", accountType: "CURRENT", balanceMinor: 0n, currency: "GBP", ...extra } });
}
async function catId(userId: string, code: string): Promise<string> {
  const c = await prisma.category.findFirst({ where: { userId, code } });
  return c.id;
}

describe("Phase 6 — §2.1 PROVIDER-authoritative balance is immune to every creation path", () => {
  it("manual transaction creation never moves a PROVIDER account's balance", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id, { balanceAuthority: "PROVIDER", balanceMinor: 500000n });
    await svc.txns.createTransaction(u.id, { accountId: a.id, direction: "EXPENSE", amountMinor: 4200, description: "Manual entry", bookedAt: new Date() });
    const after = await prisma.bankAccount.findUnique({ where: { id: a.id } });
    expect(after.balanceMinor).toBe(500000n);
  });

  it("notification approval (web flow) never moves a PROVIDER account's balance, and classifies transfers", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id, { balanceAuthority: "PROVIDER", balanceMinor: 100000n });
    const b = await account(u.id, { nickname: "Savings", accountType: "SAVINGS" });
    const item = await svc.notif.ingestNotification(u.id, { sourcePackage: "co.uk.monzo", title: "Payment", message: "You paid £25.00 at Tesco" });
    const txn = await svc.notif.approveNotification(u.id, item.id, { accountId: a.id });
    const after = await prisma.bankAccount.findUnique({ where: { id: a.id } });
    expect(after.balanceMinor).toBe(100000n); // unchanged — provider authoritative
    expect(txn.balanceApplied).toBe(false);

    // §2.2 — the web approval flow must classify like the mobile flow: an internal
    // transfer approved from the web UI must end up excluded from spend.
    const item2 = await svc.notif.ingestNotification(u.id, { sourcePackage: "co.uk.monzo", title: "Payment", message: "You paid £100.00 to Savings" });
    await prisma.transaction.create({
      data: { userId: u.id, accountId: b.id, direction: "INCOME", amountMinor: 10000n, currency: "GBP", bookedAt: new Date(), description: "From current", account: undefined },
    });
    const txn2 = await svc.notif.approveNotification(u.id, item2.id, { accountId: a.id, parsedAmountMinor: 10000 });
    const reloaded = await prisma.transaction.findUnique({ where: { id: txn2.id } });
    expect(reloaded.transactionType).toBe("INTERNAL_TRANSFER");
    expect(reloaded.internalTransferGroupId).toBeTruthy();
  });

  it("the legacy CSV importer never moves a PROVIDER account's balance", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id, { balanceAuthority: "PROVIDER", balanceMinor: 250000n });
    const mapping = { accountId: a.id, hasHeader: true, dateFormat: "DMY" as const, columns: { date: 0, description: 1, amount: 2 } };
    const text = "Date,Description,Amount\n10/08/2026,Tesco,-42.00\n11/08/2026,Salary,2000.00";
    const result = await svc.csv.commitCsv(u.id, text, mapping, "hist.csv", true);
    expect(result.imported).toBe(2);
    const after = await prisma.bankAccount.findUnique({ where: { id: a.id } });
    expect(after.balanceMinor).toBe(250000n); // untouched by historical CSV import

    // A LEDGER account still behaves normally (regression — the fix must not
    // break the ordinary, non-provider case).
    const ledgerAcc = await account(u.id, { balanceMinor: 0n });
    const mapping2 = { ...mapping, accountId: ledgerAcc.id };
    await svc.csv.commitCsv(u.id, text, mapping2, "hist2.csv", true);
    const ledgerAfter = await prisma.bankAccount.findUnique({ where: { id: ledgerAcc.id } });
    expect(ledgerAfter.balanceMinor).toBe(195800n); // -4200 + 200000
  });

  it("a transfer counterparty that is PROVIDER-authoritative is never decremented", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const ledger = await account(u.id, { balanceMinor: 0n });
    const provider = await account(u.id, { balanceAuthority: "PROVIDER", balanceMinor: 999900n, nickname: "Provider" });
    await svc.txns.createTransaction(u.id, {
      accountId: ledger.id, direction: "EXPENSE", amountMinor: 5000, description: "To provider account",
      transferAccountId: provider.id, transactionType: "TRANSFER", bookedAt: new Date(),
    });
    const providerAfter = await prisma.bankAccount.findUnique({ where: { id: provider.id } });
    expect(providerAfter.balanceMinor).toBe(999900n); // untouched
    const ledgerAfter = await prisma.bankAccount.findUnique({ where: { id: ledger.id } });
    expect(ledgerAfter.balanceMinor).toBe(-5000n); // the LEDGER side still moves
  });
});

describe("Phase 6 — §2.3 CSV/report export formula-injection protection", () => {
  it("the legacy reports CSV export neutralises formula-injection cells", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id);
    await svc.txns.createTransaction(u.id, { accountId: a.id, direction: "EXPENSE", amountMinor: 100, description: "=1+1", merchantName: "@SUM(A1)", bookedAt: new Date() });
    const csv = await svc.reports.transactionsCsv(u.id, { from: new Date(Date.now() - 86400000), to: new Date(Date.now() + 86400000) });
    expect(csv).toMatch(/'=1\+1|"'=1\+1/);
    expect(csv.toLowerCase()).toMatch(/'@sum/);
  });
});

describe("Phase 6 — Direct Debit end-to-end: British Gas £82 / £79 / £125", () => {
  it("one mandate accumulates full history, learns the expectation, flags the £125 spike, and totals correctly", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id);
    const amounts = [8200, 7900, 12500];
    let last: any;
    for (let i = 0; i < amounts.length; i++) {
      const txn = await svc.txns.createTransaction(u.id, {
        accountId: a.id, direction: "EXPENSE", amountMinor: amounts[i], description: "BRITISH GAS DIRECT DEBIT",
        merchantName: "British Gas", bookedAt: new Date(Date.now() - (amounts.length - i) * 30 * 86400000),
      });
      last = await svc.direct.detectDirectDebit(u.id, txn.id, {
        merchant: "British Gas", text: "BRITISH GAS DIRECT DEBIT", amountMinor: amounts[i],
        accountId: a.id, bookedAt: txn.bookedAt, direction: "EXPENSE", reference: null,
      });
    }
    const mandates = await prisma.directDebitMandate.findMany({ where: { userId: u.id, normalizedCompanyName: { contains: "britishgas" } } });
    expect(mandates.length).toBe(1); // one company, not three
    const mandate = mandates[0];
    expect(mandate.paymentCount).toBe(3);
    // The £125 payment (well above the £79-£82 range) is flagged as an anomaly.
    expect(last.anomaly).not.toBe("NORMAL");

    const history = await prisma.transaction.findMany({ where: { userId: u.id, directDebitMandateId: mandate.id } });
    expect(history.length).toBe(3);
    const monthlyTotal = history.reduce((s: bigint, t: any) => s + t.amountMinor, 0n);
    expect(monthlyTotal).toBe(28600n); // 82+79+125

    // Distinct classification: this is a DIRECT_DEBIT, never a SUBSCRIPTION/RECURRING_CARD/STANDING_ORDER.
    expect(mandate.kind).toBe("DIRECT_DEBIT");
  });
});

describe("Phase 6 — subscription detection: named merchants + weak-repeat guard", () => {
  it("detects Netflix, Spotify and Amazon Prime as monthly subscriptions with correct annual equivalents", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id);
    const merchants: Array<[string, number]> = [["Netflix", 1099], ["Spotify", 999], ["Amazon Prime", 879]];
    for (const [name, amount] of merchants) {
      for (let i = 4; i >= 1; i--) {
        await svc.txns.createTransaction(u.id, {
          accountId: a.id, direction: "EXPENSE", amountMinor: amount, description: `${name.toUpperCase()} SUBSCRIPTION`,
          merchantName: name, bookedAt: new Date(Date.now() - i * 30 * 86400000),
        });
      }
    }
    const subs = await svc.recurring.detectSubscriptions(u.id);
    for (const [name, amount] of merchants) {
      const found = subs.find((s: any) => s.merchantName.toLowerCase().includes(name.toLowerCase().split(" ")[0]));
      expect(found, `${name} should be detected`).toBeTruthy();
      expect(["CONFIRMED", "HIGH_CONFIDENCE"]).toContain(found.confidence);
      expect(found.averageAmountMinor).toBe(amount);
    }
  });

  it("does not flag two irregular, weakly-repeated purchases as a subscription", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id);
    // Only two purchases, months apart, at different amounts — not a confident pattern.
    await svc.txns.createTransaction(u.id, { accountId: a.id, direction: "EXPENSE", amountMinor: 1500, description: "CORNER SHOP", merchantName: "Corner Shop", bookedAt: new Date(Date.now() - 90 * 86400000) });
    await svc.txns.createTransaction(u.id, { accountId: a.id, direction: "EXPENSE", amountMinor: 3200, description: "CORNER SHOP", merchantName: "Corner Shop", bookedAt: new Date() });
    const subs = await svc.recurring.detectSubscriptions(u.id);
    expect(subs.find((s: any) => s.merchantName.toLowerCase().includes("corner shop"))).toBeUndefined();
  });
});

describe("Phase 6 — timezone: a transaction near UTC midnight reports in the user's local month", () => {
  it("a transaction at 2026-05-01T05:00Z counts toward April for a Los-Angeles user, not May", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id);
    // 05:00 UTC on 1 May is still 30 April 22:00 in America/Los_Angeles (PDT, UTC-7).
    await svc.txns.createTransaction(u.id, { accountId: a.id, direction: "EXPENSE", amountMinor: 5000, description: "Late April spend", bookedAt: new Date("2026-05-01T05:00:00Z") });
    const aprilSummary = await svc.insights.monthlySummary(u.id, "America/Los_Angeles", new Date("2026-04-15T12:00:00Z"));
    const maySummary = await svc.insights.monthlySummary(u.id, "America/Los_Angeles", new Date("2026-05-15T12:00:00Z"));
    const aprilGbp = aprilSummary.currencies.find((c: any) => c.currency === "GBP");
    const mayGbp = maySummary.currencies.find((c: any) => c.currency === "GBP");
    expect(aprilGbp?.spendingMinor ?? 0).toBe(5000); // counted in the LOCAL month (April)
    expect(mayGbp?.spendingMinor ?? 0).toBe(0);
  });
});

describe("Phase 6 — Review Centre surfaces every uncertain category (§16)", () => {
  it("populates possible internal transfers, possible subscriptions, and uncategorized transactions", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id, { accountType: "CURRENT" });
    const b = await account(u.id, { accountType: "SAVINGS" });

    // A single-sided possible transfer: counterparty name matches another of the
    // user's own account holders, but there's no opposite-side transaction yet.
    await prisma.bankAccount.update({ where: { id: b.id }, data: { accountHolderName: "Sardar Saeed" } });
    const possibleTransfer = await svc.txns.createTransaction(u.id, { accountId: a.id, direction: "EXPENSE", amountMinor: 5000, description: "To Sardar Saeed", recipientName: "Sardar Saeed", bookedAt: new Date() });
    const { detectAndPairInternalTransfer } = await import("./internal-transfer.service.js");
    await detectAndPairInternalTransfer(u.id, possibleTransfer.id);

    // A possible subscription: three-plus regular Spotify charges.
    for (let i = 3; i >= 1; i--) {
      await svc.txns.createTransaction(u.id, { accountId: a.id, direction: "EXPENSE", amountMinor: 999, description: "SPOTIFY", merchantName: "Spotify", bookedAt: new Date(Date.now() - i * 30 * 86400000) });
    }

    // An uncategorized transaction. Normal creation always resolves to at least
    // the "Other" fallback category (never leaves categoryId null), so this
    // simulates the real, reachable case of a category being explicitly
    // cleared afterward (e.g. a manual correction).
    const uncategorizedSrc = await svc.txns.createTransaction(u.id, { accountId: a.id, direction: "EXPENSE", amountMinor: 750, description: "ZZZQ UNKNOWN MERCHANT", merchantName: "Zzzq Unknown Merchant", bookedAt: new Date() });
    const uncategorized = await prisma.transaction.update({ where: { id: uncategorizedSrc.id }, data: { categoryId: null } });

    const centre = await svc.review.getReviewCentre(u.id);
    expect(centre.possibleInternalTransfers.some((t: any) => t.id === possibleTransfer.id)).toBe(true);
    expect(centre.possibleSubscriptions.some((s: any) => s.merchantName.toLowerCase().includes("spotify"))).toBe(true);
    expect(centre.uncategorized.some((t: any) => t.id === uncategorized.id)).toBe(true);
    expect(centre.counts.possibleInternalTransfers).toBeGreaterThan(0);
    expect(centre.counts.possibleSubscriptions).toBeGreaterThan(0);
    expect(centre.counts.uncategorized).toBeGreaterThan(0);
  });
});

describe("Phase 6 — corrections audit never itself applies a balance effect", () => {
  it("recording a category-change correction does not touch any account balance", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id, { balanceMinor: 10000n });
    const groceries = await catId(u.id, "GROCERIES");
    const txn = await svc.txns.createTransaction(u.id, { accountId: a.id, direction: "EXPENSE", amountMinor: 500, description: "Corner shop", bookedAt: new Date() });
    await svc.corrections.recordCorrection(u.id, { transactionId: txn.id, action: "CATEGORY_CHANGE", before: { categoryId: txn.categoryId }, after: { categoryId: groceries } });
    const after = await prisma.bankAccount.findUnique({ where: { id: a.id } });
    expect(after.balanceMinor).toBe(9500n); // only the original transaction's effect, unchanged by the audit write
    const audit = await prisma.transactionCorrection.findFirst({ where: { userId: u.id, transactionId: txn.id, action: "CATEGORY_CHANGE" } });
    expect(audit).toBeTruthy();
  });
});

describe("Phase 6 — canonical-ledger re-audit: rollbackBatch reverses balance before deleting", () => {
  it("rolling back a CSV import batch restores the pre-import balance exactly", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id, { balanceMinor: 500000n });
    const mapping = { accountId: a.id, hasHeader: true, dateFormat: "DMY" as const, columns: { date: 0, description: 1, amount: 2 } };
    const text = "Date,Description,Amount\n10/08/2026,Tesco,-42.00\n11/08/2026,Salary,2000.00";
    const result = await svc.csv.commitCsv(u.id, text, mapping, "rollback-test.csv", true);
    expect(result.imported).toBe(2);
    const afterImport = await prisma.bankAccount.findUnique({ where: { id: a.id } });
    expect(afterImport.balanceMinor).toBe(695800n); // 500000 - 4200 + 200000

    const deletedCount = await svc.csv.rollbackBatch(u.id, result.batchId);
    expect(deletedCount).toBe(2);
    const afterRollback = await prisma.bankAccount.findUnique({ where: { id: a.id } });
    // Before this fix, rollback deleted the rows without reversing their balance
    // effect, permanently corrupting the balance at 695800 instead of restoring
    // the original 500000.
    expect(afterRollback.balanceMinor).toBe(500000n);
    const remaining = await prisma.transaction.count({ where: { userId: u.id, importBatchId: result.batchId } });
    expect(remaining).toBe(0);
  });

  it("does not move a PROVIDER-authoritative account's balance, and reversal is a no-op for it either", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id, { balanceAuthority: "PROVIDER", balanceMinor: 300000n });
    const mapping = { accountId: a.id, hasHeader: true, dateFormat: "DMY" as const, columns: { date: 0, description: 1, amount: 2 } };
    const text = "Date,Description,Amount\n10/08/2026,Tesco,-42.00";
    const result = await svc.csv.commitCsv(u.id, text, mapping, "provider-rollback.csv", true);
    await svc.csv.rollbackBatch(u.id, result.batchId);
    const after = await prisma.bankAccount.findUnique({ where: { id: a.id } });
    expect(after.balanceMinor).toBe(300000n); // untouched throughout
  });
});
