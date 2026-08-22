import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Direct Debit Intelligence & Reconciliation round — end-to-end regression
// coverage for the real-device Manchester City Council £170 case: an
// UPCOMING Direct Debit pre-alert reconciling with the later COMPLETED
// notification for the SAME occurrence (not creating a second, disconnected
// FinancialEvent), a confidence-gated next-cycle prediction that no longer
// silently reserves a single-payment guess against Safe-to-Spend, and a
// spread of other real-world Direct-Debit-collected payment shapes (credit-
// card repayments, insurance, utilities, subscriptions). Own file so a
// DATABASE_URL failure skips cleanly rather than being silently swallowed by
// an unrelated file's beforeAll.

let ready = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ingestFinancialEvent: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cashflow: any;

beforeAll(async () => {
  const dbUrl = process.env.MOBILE_TEST_DATABASE_URL;
  if (!dbUrl) return;
  process.env.DATABASE_URL = dbUrl;
  process.env.MOBILE_JWT_SECRET ||= "test-mobile-secret-0123456789abcdef";
  process.env.SESSION_SECRET ||= "test-session-secret-0123456789abcdef";
  try {
    prisma = (await import("../../db.js")).prisma;
    await prisma.$queryRaw`SELECT 1`;
    ingestFinancialEvent = (await import("./financial-event.service.js")).ingestFinancialEvent;
    cashflow = await import("../cashflow.service.js");
    ready = true;
  } catch {
    ready = false;
  }
});

afterAll(async () => {
  if (ready && prisma) await prisma.user.deleteMany({ where: { email: { contains: "ddreconcile+" } } });
});

async function newUser(tag: string) {
  const email = `ddreconcile+${tag}${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`.toLowerCase();
  const user = await prisma.user.create({ data: { email, passwordHash: "x" } });
  return user.id as string;
}

async function newAccount(userId: string, over: Partial<{ bankName: string; accountType: string; balanceMinor: bigint }> = {}) {
  const acc = await prisma.bankAccount.create({
    data: { userId, bankName: over.bankName ?? "Monzo", nickname: over.bankName ?? "Monzo", accountType: (over.accountType as never) ?? "CURRENT", currency: "GBP", balanceMinor: over.balanceMinor ?? 0n },
  });
  return acc.id as string;
}

let fpCounter = 0;
function fp(tag: string) {
  fpCounter += 1;
  return `fp-ddreconcile-${tag}-${Date.now()}-${fpCounter}`;
}

describe("Direct Debit Intelligence & Reconciliation — Manchester £170 (§14)", () => {
  it("reconciles the UPCOMING pre-alert with the later COMPLETED payment into ONE occurrence, and Safe-to-Spend stops reserving the settled amount", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("manchester");
    const acc = await newAccount(userId, { balanceMinor: 332371n });

    // 1. Bank pre-alert, ~5 days before the debit: "MANCHESTER C C leaves
    // your account on August 16: £170.00 Direct Debit". Deliberately generic
    // wording (no "repayment"/mandate-specific language) matching the real
    // device report.
    const upcoming = await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.monzo", sourceFingerprint: fp("upcoming"), trustedSource: false,
      title: "MANCHESTER C C", redactedText: "leaves your account on August 16: £170.00 Direct Debit",
      clientDirection: "EXPENSE", occurredAt: new Date("2026-08-11T09:00:00Z"),
    });
    expect(upcoming.event.lifecycle).toBe("UPCOMING");
    expect(upcoming.event.eventKind).toBe("DIRECT_DEBIT");
    expect(upcoming.event.merchantName).toBe("MANCHESTER C C");
    expect(upcoming.transaction).toBeNull();

    // 2. The real completed debit, 5 days later. The on-device merchant hint
    // is deliberately the garbled real-world string ("Manchester C C Leaves
    // Your") to prove the collector-normalisation fix, not just the
    // reconciliation fix, is doing real work here.
    const completed = await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.monzo", sourceFingerprint: fp("completed"), trustedSource: false,
      title: "Manchester C C Leaves Your", merchantHint: "Manchester C C Leaves Your",
      redactedText: "Payment made -£170.00 Direct debit", clientDirection: "EXPENSE", clientAmountMinor: 17000, clientConfidence: 0.95,
      occurredAt: new Date("2026-08-16T09:00:00Z"),
    });

    // The SAME FinancialEvent row transitioned UPCOMING -> COMPLETED, rather
    // than a second, disconnected row being created for the same real-world
    // payment — this is the core fix.
    expect(completed.event.id).toBe(upcoming.event.id);
    expect(completed.event.lifecycle).toBe("COMPLETED");
    expect(completed.event.merchantName).toBe("MANCHESTER C C"); // cleaned, not the garbled hint
    expect(completed.transaction).toBeTruthy();
    expect(completed.transaction!.amountMinor).toBe(17000n);
    expect(completed.duplicate).toBe(false);

    // No orphaned UPCOMING row survives for this collector — exactly one
    // FinancialEvent total for this account/mandate.
    const events = await prisma.financialEvent.findMany({ where: { userId, accountId: acc } });
    expect(events.length).toBe(1);
    expect(events[0].lifecycle).toBe("COMPLETED");

    // Exactly one canonical Transaction, attached to exactly one
    // DirectDebitMandate, with the balance decremented exactly once.
    const mandates = await prisma.directDebitMandate.findMany({ where: { userId, accountId: acc } });
    expect(mandates.length).toBe(1);
    expect(mandates[0].paymentCount).toBe(1);
    const accAfter = await prisma.bankAccount.findUnique({ where: { id: acc } });
    expect(accAfter.balanceMinor).toBe(332371n - 17000n);

    // A single completed payment predicts a next MONTHLY occurrence (Sep 16)
    // purely from the default cadence assumption — real evidence, but not
    // yet CONFIRMED by a second observed payment. It must show as a
    // low-confidence Forecast, and Safe-to-Spend must not reserve it.
    const upcomingList = await cashflow.upcomingPayments(userId, 45, new Date("2026-08-21T09:00:00Z"));
    const manchesterItem = upcomingList.find((i: { name: string }) => i.name.toLowerCase().includes("manchester"));
    expect(manchesterItem).toBeTruthy();
    expect(manchesterItem.label).toBe("Forecast");

    const safe = await cashflow.safeToSpend(userId, 0, new Date("2026-08-21T09:00:00Z"));
    expect(safe.upcomingCommittedMinor).toBe(0); // the settled August £170 is no longer reserved
    expect(safe.safeToSpendMinor).toBe(332371 - 17000); // only the real, already-applied balance effect
    expect(safe.contributingItems).toEqual([]);
  });
});

describe("Direct Debit Intelligence — Safe-to-Spend confidence gating (§7/§15)", () => {
  it("a stale single-payment guess is never subtracted; a genuinely recurring (2+ payment) obligation inside the horizon IS", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("safetospend");
    const acc = await newAccount(userId, { balanceMinor: 332371n });

    // First-ever payment for "Spotify" — a single data point, no confirmed
    // cadence yet.
    await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.monzo", sourceFingerprint: fp("spotify1"), trustedSource: false,
      title: "Spotify", redactedText: "Payment made -£9.99 Direct debit subscription",
      clientDirection: "EXPENSE", clientAmountMinor: 999, clientConfidence: 0.95,
      occurredAt: new Date("2026-07-21T09:00:00Z"),
    });
    const afterFirst = await cashflow.safeToSpend(userId, 0, new Date("2026-08-05T09:00:00Z"));
    expect(afterFirst.upcomingCommittedMinor).toBe(0); // single-payment guess never reserved

    // A second, genuinely recurring collector ("British Gas") with TWO real
    // payments a month apart — real cadence evidence.
    await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.monzo", sourceFingerprint: fp("gas1"), trustedSource: false,
      title: "British Gas", redactedText: "Payment made -£82.00 Direct debit",
      clientDirection: "EXPENSE", clientAmountMinor: 8200, clientConfidence: 0.95,
      occurredAt: new Date("2026-07-05T09:00:00Z"),
    });
    await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.monzo", sourceFingerprint: fp("gas2"), trustedSource: false,
      title: "British Gas", redactedText: "Payment made -£82.00 Direct debit",
      clientDirection: "EXPENSE", clientAmountMinor: 8200, clientConfidence: 0.95,
      occurredAt: new Date("2026-08-05T09:00:00Z"),
    });

    const gasMandate = await prisma.directDebitMandate.findFirst({ where: { userId, normalizedCompanyName: "britishgas" } });
    expect(gasMandate.paymentCount).toBe(2);

    const now = new Date("2026-08-10T09:00:00Z"); // British Gas's predicted Sep-5 date is within a 30-day horizon from here
    const safe = await cashflow.safeToSpend(userId, 0, now);
    expect(safe.upcomingCommittedMinor).toBe(8200); // the genuinely recurring British Gas payment IS reserved
    expect(safe.contributingItems.map((i: { name: string }) => i.name)).toContain("British Gas");
    // Spotify's single-payment guess still never appears in the reserved total.
    expect(safe.contributingItems.some((i: { name: string }) => i.name.toLowerCase().includes("spotify"))).toBe(false);
  });
});

describe("Direct Debit Intelligence — other real-world collector shapes (§9/§16)", () => {
  it("Capital One repayment via Direct Debit: CREDIT_CARD_REPAYMENT + DIRECT_DEBIT rail, excluded from spending", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("capitalone");
    const acc = await newAccount(userId, { balanceMinor: 100000n });
    await newAccount(userId, { bankName: "Capital One", accountType: "CREDIT_CARD" });

    const r = await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.monzo", sourceFingerprint: fp("capitalone"), trustedSource: false,
      title: "Capital One", redactedText: "Payment made -£120.00 Direct debit statement repayment",
      clientDirection: "EXPENSE", clientAmountMinor: 12000, clientConfidence: 0.95, occurredAt: new Date("2026-08-16T09:00:00Z"),
    });
    expect(r.event.eventKind).toBe("CREDIT_CARD_REPAYMENT");
    expect(r.event.paymentRail).toBe("DIRECT_DEBIT");
    expect(r.event.analyticsRole).toBe("LIABILITY_REPAYMENT");
    expect(r.transaction!.transactionType).toBe("CREDIT_CARD_REPAYMENT");
  });

  it("Zable repayment via Direct Debit: CREDIT_CARD_REPAYMENT + DIRECT_DEBIT rail, attaches to the mandate seeded by its own earlier pre-alert (§8)", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("zable");
    const acc = await newAccount(userId, { balanceMinor: 100000n });
    await newAccount(userId, { bankName: "Zable", accountType: "CREDIT_CARD" });

    // A repayment mandate is only ever ATTACHED to, never spawned fresh, by
    // the completed-repayment path alone (linkCreditCardRepaymentToMandate())
    // — exactly like the real world, an UPCOMING pre-alert normally seeds it
    // first (see recordUpcomingDirectDebitLike()).
    await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.monzo", sourceFingerprint: fp("zable-upcoming"), trustedSource: false,
      title: "Zable", redactedText: "Your monthly repayment of £254.43 will be taken on a future date",
      clientDirection: "EXPENSE", occurredAt: new Date("2026-08-11T09:00:00Z"),
    });

    const r = await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.monzo", sourceFingerprint: fp("zable-completed"), trustedSource: false,
      title: "Zable", redactedText: "Payment made -£254.43 Direct debit",
      clientDirection: "EXPENSE", clientAmountMinor: 25443, clientConfidence: 0.95, occurredAt: new Date("2026-08-16T09:00:00Z"),
    });
    expect(r.event.eventKind).toBe("CREDIT_CARD_REPAYMENT");
    expect(r.event.paymentRail).toBe("DIRECT_DEBIT");
    const mandate = await prisma.directDebitMandate.findFirst({ where: { userId, normalizedCompanyName: "zable" } });
    expect(mandate).toBeTruthy();
    expect(r.transaction!.directDebitMandateId).toBe(mandate.id);
  });

  it("Monzo Flex repayment via Direct Debit: CREDIT_CARD_REPAYMENT, never ordinary spending", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("monzoflex");
    const acc = await newAccount(userId, { balanceMinor: 100000n });
    await newAccount(userId, { bankName: "Monzo Flex", accountType: "CREDIT_CARD" });

    const r = await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.monzo", sourceFingerprint: fp("monzoflex"), trustedSource: false,
      title: "Monzo Flex", redactedText: "Payment made -£60.00 Direct debit",
      clientDirection: "EXPENSE", clientAmountMinor: 6000, clientConfidence: 0.95, occurredAt: new Date("2026-08-16T09:00:00Z"),
    });
    expect(r.event.eventKind).toBe("CREDIT_CARD_REPAYMENT");
    expect(r.event.analyticsRole).toBe("LIABILITY_REPAYMENT");
  });

  it("car insurance Direct Debit: plain DIRECT_DEBIT eventKind, INSURANCE collector-category hint", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("insurance");
    const acc = await newAccount(userId, { balanceMinor: 100000n });
    const r = await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.monzo", sourceFingerprint: fp("insurance"), trustedSource: false,
      title: "Admiral Insurance", redactedText: "Payment made -£45.00 Direct debit",
      clientDirection: "EXPENSE", clientAmountMinor: 4500, clientConfidence: 0.95, occurredAt: new Date("2026-08-16T09:00:00Z"),
    });
    expect(r.event.eventKind).toBe("DIRECT_DEBIT");
    expect(r.event.paymentRail).toBe("DIRECT_DEBIT");
    expect(r.event.classificationReasons).toContain("COLLECTOR_CATEGORY_INSURANCE");
  });

  it("utility Direct Debit (British Gas): plain DIRECT_DEBIT eventKind, UTILITIES collector-category hint", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("utility");
    const acc = await newAccount(userId, { balanceMinor: 100000n });
    const r = await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.monzo", sourceFingerprint: fp("utility"), trustedSource: false,
      title: "British Gas", redactedText: "Payment made -£82.00 Direct debit",
      clientDirection: "EXPENSE", clientAmountMinor: 8200, clientConfidence: 0.95, occurredAt: new Date("2026-08-16T09:00:00Z"),
    });
    expect(r.event.eventKind).toBe("DIRECT_DEBIT");
    expect(r.event.classificationReasons).toContain("COLLECTOR_CATEGORY_UTILITIES");
  });

  it("subscription collected via Direct Debit rail keeps its own eventKind, never DIRECT_DEBIT/repayment", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("subscription");
    const acc = await newAccount(userId, { balanceMinor: 100000n });
    const r = await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.monzo", sourceFingerprint: fp("subscription"), trustedSource: false,
      title: "Netflix", redactedText: "Payment made -£15.99 Direct debit subscription",
      clientDirection: "EXPENSE", clientAmountMinor: 1599, clientConfidence: 0.95, occurredAt: new Date("2026-08-16T09:00:00Z"),
    });
    expect(r.event.eventKind).toBe("SUBSCRIPTION");
    expect(r.event.classificationReasons).toContain("COLLECTOR_CATEGORY_SUBSCRIPTION");
  });

  it("council tax Direct Debit stays DIRECT_DEBIT, never CREDIT_CARD_REPAYMENT, with a COUNCIL_TAX hint", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("counciltax");
    const acc = await newAccount(userId, { balanceMinor: 332371n });
    const r = await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.monzo", sourceFingerprint: fp("counciltax"), trustedSource: false,
      title: "Manchester City Council", redactedText: "Payment made -£170.00 Direct debit",
      clientDirection: "EXPENSE", clientAmountMinor: 17000, clientConfidence: 0.95, occurredAt: new Date("2026-08-16T09:00:00Z"),
    });
    expect(r.event.eventKind).toBe("DIRECT_DEBIT");
    expect(r.event.classificationReasons).toContain("COLLECTOR_CATEGORY_COUNCIL_TAX");
  });
});

describe("Direct Debit Intelligence — user-confirmed collector alias (§12)", () => {
  it("a confirmed alias overrides the raw collector name in upcomingPayments(), without changing mandate identity", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("alias");
    const acc = await newAccount(userId, { balanceMinor: 332371n });
    const { confirmCollectorAlias } = await import("../direct-debit.service.js");

    await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.monzo", sourceFingerprint: fp("alias-upcoming"), trustedSource: false,
      title: "MANCHESTER C C", redactedText: "leaves your account on September 16: £170.00 Direct Debit",
      clientDirection: "EXPENSE", occurredAt: new Date("2026-08-21T09:00:00Z"),
    });

    const mandate = await prisma.directDebitMandate.findFirst({ where: { userId, normalizedCompanyName: "manchestercc" } });
    expect(mandate).toBeTruthy();

    const ok = await confirmCollectorAlias(userId, mandate.id, "Manchester City Council");
    expect(ok).toBe(true);

    const upcomingList = await cashflow.upcomingPayments(userId, 45, new Date("2026-08-21T09:00:00Z"));
    const item = upcomingList.find((i: { id: string }) => i.id === mandate.id);
    expect(item.name).toBe("Manchester City Council");

    // Identity is untouched — a later completed payment for the same raw
    // collector text still resolves to THIS mandate, not a new one.
    const mandateAfter = await prisma.directDebitMandate.findUnique({ where: { id: mandate.id } });
    expect(mandateAfter.normalizedCompanyName).toBe("manchestercc");
  });

  it("returns false, never throws, for a mandate that does not belong to the caller", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("alias-owner");
    const otherUserId = await newUser("alias-other");
    const acc = await newAccount(userId);
    await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.monzo", sourceFingerprint: fp("alias-ownership"), trustedSource: false,
      title: "MANCHESTER C C", redactedText: "leaves your account on September 16: £170.00 Direct Debit",
      clientDirection: "EXPENSE", occurredAt: new Date("2026-08-21T09:00:00Z"),
    });
    const mandate = await prisma.directDebitMandate.findFirst({ where: { userId, normalizedCompanyName: "manchestercc" } });
    const { confirmCollectorAlias } = await import("../direct-debit.service.js");
    const ok = await confirmCollectorAlias(otherUserId, mandate.id, "Should Not Apply");
    expect(ok).toBe(false);
    const unchanged = await prisma.directDebitMandate.findUnique({ where: { id: mandate.id } });
    expect(unchanged.merchantAlias).toBeNull();
  });
});

describe("Direct Debit Intelligence — duplicate protection (§17)", () => {
  it("re-ingesting the exact same COMPLETED notification twice never double-links or double-decrements the balance", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("duplicate");
    const acc = await newAccount(userId, { balanceMinor: 332371n });
    const fingerprint = fp("dup-completed");

    const notif = {
      accountId: acc, sourcePackage: "unknown.monzo", sourceFingerprint: fingerprint, trustedSource: false,
      title: "MANCHESTER C C", redactedText: "Payment made -£170.00 Direct debit",
      clientDirection: "EXPENSE" as const, clientAmountMinor: 17000, clientConfidence: 0.95, occurredAt: new Date("2026-08-16T09:00:00Z"),
    };
    const first = await ingestFinancialEvent(userId, notif);
    const second = await ingestFinancialEvent(userId, notif);

    expect(second.duplicate).toBe(true);
    expect(second.event.id).toBe(first.event.id);
    expect(second.transaction!.id).toBe(first.transaction!.id);

    const txns = await prisma.transaction.count({ where: { userId, accountId: acc } });
    expect(txns).toBe(1);
    const mandates = await prisma.directDebitMandate.findMany({ where: { userId, accountId: acc } });
    expect(mandates.length).toBe(1);
    expect(mandates[0].paymentCount).toBe(1); // never double-counted
    const accAfter = await prisma.bankAccount.findUnique({ where: { id: acc } });
    expect(accAfter.balanceMinor).toBe(332371n - 17000n); // decremented exactly once
  });
});
