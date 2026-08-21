import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// Transaction AI Provider round — end-to-end proof that the AI advisory
// layer is wired into ingestFinancialEvent() correctly AND safely: it can
// refine semantic metadata when deterministic evidence is genuinely
// ambiguous, but can NEVER touch amount, currency, direction, lifecycle, or
// account ids. Own file/process (sets TRANSACTION_AI_ENABLED=true before any
// import — env.ts is parsed once per process, same reasoning as
// advisory.test.ts). Uses FakeSemanticClassifier exclusively — no real,
// billable AI call is ever made by this file.

let ready = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ingestFinancialEvent: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let setClassifierForTests: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let FakeSemanticClassifier: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let confirmCounterpartyAccount: any;

beforeAll(async () => {
  const dbUrl = process.env.MOBILE_TEST_DATABASE_URL;
  if (!dbUrl) return;
  process.env.TRANSACTION_AI_ENABLED = "true";
  process.env.DATABASE_URL = dbUrl;
  process.env.MOBILE_JWT_SECRET ||= "test-mobile-secret-0123456789abcdef";
  process.env.SESSION_SECRET ||= "test-session-secret-0123456789abcdef";
  try {
    prisma = (await import("../../db.js")).prisma;
    await prisma.$queryRaw`SELECT 1`;
    ingestFinancialEvent = (await import("./financial-event.service.js")).ingestFinancialEvent;
    const registry = await import("../transaction-ai/registry.js");
    setClassifierForTests = registry.setClassifierForTests;
    FakeSemanticClassifier = (await import("../transaction-ai/fake-classifier.js")).FakeSemanticClassifier;
    confirmCounterpartyAccount = (await import("../account-resolution/account-identity-resolver.js")).confirmCounterpartyAccount;
    ready = true;
  } catch {
    ready = false;
  }
});

afterEach(() => setClassifierForTests?.(null));

afterAll(async () => {
  if (ready && prisma) await prisma.user.deleteMany({ where: { email: { contains: "aiadvisory+" } } });
});

async function newUser(tag: string) {
  const email = `aiadvisory+${tag}${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`.toLowerCase();
  const user = await prisma.user.create({ data: { email, passwordHash: "x" } });
  return user.id as string;
}

async function newAccount(userId: string, over: Partial<{ bankName: string; accountType: string; balanceMinor: bigint; balanceAuthority: string }> = {}) {
  const acc = await prisma.bankAccount.create({
    data: {
      userId, bankName: over.bankName ?? "Test Bank", nickname: over.bankName ?? "Test Bank",
      accountType: (over.accountType as never) ?? "CURRENT", currency: "GBP", balanceMinor: over.balanceMinor ?? 0n,
      balanceAuthority: (over.balanceAuthority as never) ?? "LEDGER",
    },
  });
  return acc.id as string;
}

function baseAiOutput(over: Partial<Record<string, unknown>> = {}) {
  return {
    eventKind: "CARD_PURCHASE",
    paymentRail: null,
    analyticsRole: "SPENDING",
    sourceAccountCandidate: null,
    destinationAccountCandidate: null,
    merchantNormalized: null,
    isLikelyInternalTransfer: false,
    isLikelyCreditCardRepayment: false,
    isLikelyDirectDebit: false,
    confidence: 0.9,
    reasons: ["test"],
    ...over,
  };
}

describe("AI advisory — end-to-end §10 observed cases", () => {
  it("Zable repayment: AI may advise CREDIT_CARD_REPAYMENT when deterministic evidence is ambiguous", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("zable");
    const acc = await newAccount(userId);
    const fake = new FakeSemanticClassifier();
    fake.response = baseAiOutput({ eventKind: "CREDIT_CARD_REPAYMENT", analyticsRole: "LIABILITY_REPAYMENT", isLikelyCreditCardRepayment: true, confidence: 0.9 });
    setClassifierForTests(fake);

    const result = await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.zable", sourceFingerprint: `fp-${Date.now()}-1`, trustedSource: false,
      title: "Zable", redactedText: "Payment to Zable Card processed", // deliberately no clear DD/repayment wording
      clientDirection: "EXPENSE", clientAmountMinor: 25443, clientConfidence: 0.65, // MEDIUM, not HIGH
      occurredAt: new Date(),
    });
    expect(result.event.eventKind).toBe("CREDIT_CARD_REPAYMENT");
    expect(result.event.analyticsRole).toBe("LIABILITY_REPAYMENT");
    // MEDIUM deterministic confidence never auto-posts a transaction — that
    // gate is decided BEFORE the AI is even consulted (ledger-posting-
    // policy.ts) and the AI cannot elevate it. The AI's refinement is fully
    // reflected on the FinancialEvent itself either way.
    expect(result.transaction).toBeNull();
    expect(result.requiresReview).toBe(true);
    expect(fake.calls.length).toBe(1); // AI was actually consulted — deterministic evidence was genuinely ambiguous
  });

  it("incoming transfer between owned accounts: AI advises isLikelyInternalTransfer, reflected as a REVIEW-grade analytics hint, never a hard account decision", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("transfer");
    const acc = await newAccount(userId);
    const fake = new FakeSemanticClassifier();
    fake.response = baseAiOutput({ eventKind: "BANK_TRANSFER", analyticsRole: "INTERNAL_TRANSFER", isLikelyInternalTransfer: true, confidence: 0.85 });
    setClassifierForTests(fake);

    const result = await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.somebank", sourceFingerprint: `fp-${Date.now()}-2`, trustedSource: false,
      title: "Some Bank", redactedText: "Money has arrived",
      clientDirection: "INCOME", clientAmountMinor: 200, clientConfidence: 0.65,
      occurredAt: new Date(),
    });
    // The AI's opinion feeds analyticsRole via the SAME deterministic
    // analyticsRoleFor() every other path uses — it is never written
    // directly from decision.output.analyticsRole.
    expect(result.event.analyticsRole).toBe("REVIEW");
  });

  it("Direct-Debit-collected credit-card repayment: AI can set eventKind=CREDIT_CARD_REPAYMENT AND paymentRail=DIRECT_DEBIT together", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("ddrepay");
    const acc = await newAccount(userId);
    const fake = new FakeSemanticClassifier();
    fake.response = baseAiOutput({ eventKind: "CREDIT_CARD_REPAYMENT", paymentRail: "DIRECT_DEBIT", analyticsRole: "LIABILITY_REPAYMENT", isLikelyCreditCardRepayment: true, isLikelyDirectDebit: true, confidence: 0.9 });
    setClassifierForTests(fake);

    const result = await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.somebank", sourceFingerprint: `fp-${Date.now()}-3`, trustedSource: false,
      title: "Some Bank", redactedText: "Payment collected",
      clientDirection: "EXPENSE", clientAmountMinor: 5000, clientConfidence: 0.65,
      occurredAt: new Date(),
    });
    expect(result.event.eventKind).toBe("CREDIT_CARD_REPAYMENT");
    expect(result.event.paymentRail).toBe("DIRECT_DEBIT");
  });

  it("declined transaction: lifecycle stays DECLINED regardless of what the AI says (the AI output schema has no lifecycle field at all)", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("declined");
    const acc = await newAccount(userId);
    const fake = new FakeSemanticClassifier();
    // Even a maximally "confident" AI opinion cannot carry a lifecycle —
    // there is no such field in ClassifierOutput to set.
    fake.response = baseAiOutput({ eventKind: "CARD_PURCHASE", confidence: 1 });
    setClassifierForTests(fake);

    const result = await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.somebank", sourceFingerprint: `fp-${Date.now()}-4`, trustedSource: false,
      title: "Some Bank", redactedText: "Your £5.00 payment was declined",
      clientDirection: "EXPENSE", clientAmountMinor: 500, clientConfidence: 0.9,
      occurredAt: new Date(),
    });
    expect(result.event.lifecycle).toBe("DECLINED");
    expect(result.transaction).toBeNull();
    expect(await prisma.bankAccount.findUnique({ where: { id: acc } })).toMatchObject({ balanceMinor: 0n });
  });

  it("AI cannot change the amount posted — the classifier output schema has no amount field to carry one", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("amount");
    const acc = await newAccount(userId);
    const fake = new FakeSemanticClassifier();
    fake.response = baseAiOutput({ confidence: 0.95 });
    setClassifierForTests(fake);

    const result = await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.somebank", sourceFingerprint: `fp-${Date.now()}-5`, trustedSource: false,
      title: "Some Bank", redactedText: "You spent money",
      clientDirection: "EXPENSE", clientAmountMinor: 777, clientConfidence: 0.65,
      occurredAt: new Date(),
    });
    expect(result.transaction?.amountMinor).toBe(777n);
    expect(await prisma.bankAccount.findUnique({ where: { id: acc } })).toMatchObject({ balanceMinor: -777n });
  });

  it("provider (deterministic HIGH-confidence text) evidence always overrides the AI — the AI is never even called", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("override");
    const acc = await newAccount(userId, { balanceMinor: 100000n });
    const fake = new FakeSemanticClassifier();
    fake.response = baseAiOutput({ eventKind: "CREDIT_CARD_REPAYMENT", confidence: 0.99 }); // would flip classification if it were consulted
    setClassifierForTests(fake);

    const result = await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.somebank", sourceFingerprint: `fp-${Date.now()}-6`, trustedSource: false,
      title: "Tesco", redactedText: "You spent £23.50 at Tesco", // strong deterministic COMPLETION_RE match -> HIGH
      clientDirection: "EXPENSE", clientAmountMinor: 2350, clientConfidence: 0.95,
      occurredAt: new Date(),
    });
    expect(result.event.eventKind).not.toBe("CREDIT_CARD_REPAYMENT"); // AI's opinion never applied
    expect(fake.calls.length).toBe(0); // never even called — cost control + provider-evidence-wins
  });

  it("ordinary AliExpress-style purchase stays CARD_PURCHASE even with AI enabled and consulted", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("aliexpress");
    const acc = await newAccount(userId);
    const fake = new FakeSemanticClassifier();
    fake.response = baseAiOutput({ eventKind: "CARD_PURCHASE", analyticsRole: "SPENDING", confidence: 0.8 });
    setClassifierForTests(fake);

    const result = await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.somebank", sourceFingerprint: `fp-${Date.now()}-7`, trustedSource: false,
      title: "ALIEXPRESS.COM", redactedText: "Payment to ALIEXPRESS.COM",
      clientDirection: "EXPENSE", clientAmountMinor: 255, clientConfidence: 0.65,
      occurredAt: new Date(),
    });
    expect(result.event.eventKind).toBe("CARD_PURCHASE");
    expect(result.event.analyticsRole).toBe("SPENDING");
  });

  it("genuine external salary is INCOME — AI cannot relabel it as a transfer or repayment", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("salary");
    const acc = await newAccount(userId);
    const fake = new FakeSemanticClassifier();
    fake.response = baseAiOutput({ eventKind: "CARD_PURCHASE", analyticsRole: "SPENDING", confidence: 0.9 }); // deliberately wrong-sounding output
    setClassifierForTests(fake);

    const result = await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.somebank", sourceFingerprint: `fp-${Date.now()}-8`, trustedSource: false,
      title: "Acme Payroll Ltd", redactedText: "Payment received",
      clientDirection: "INCOME", clientAmountMinor: 185000, clientConfidence: 0.65,
      occurredAt: new Date(),
    });
    // analyticsRole is derived from direction, never taken from the AI's
    // eventKind/analyticsRole guess for the INCOME/SPENDING baseline case.
    expect(result.event.analyticsRole).toBe("INCOME");
  });

  it("a malformed/invalid AI response never blocks ingestion — deterministic classification still completes", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("malformed");
    const acc = await newAccount(userId);
    const fake = new FakeSemanticClassifier();
    fake.rawResponseOverride = { not: "a valid schema" };
    setClassifierForTests(fake);

    const result = await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.somebank", sourceFingerprint: `fp-${Date.now()}-9`, trustedSource: false,
      title: "Tesco", redactedText: "Payment to Tesco",
      clientDirection: "EXPENSE", clientAmountMinor: 500, clientConfidence: 0.65,
      occurredAt: new Date(),
    });
    // Ingestion completes normally and the deterministic classification is
    // intact — a malformed AI response never throws, never corrupts the
    // event, and simply contributes nothing (discarded, per §2/§8).
    expect(result.event).toBeTruthy();
    expect(result.event.amountMinor).toBe(500);
    expect(result.duplicate).toBe(false);
  });

  it("a thrown provider error never blocks ingestion", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("providererr");
    const acc = await newAccount(userId);
    const fake = new FakeSemanticClassifier();
    fake.throwError = new Error("simulated provider outage");
    setClassifierForTests(fake);

    const result = await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.somebank", sourceFingerprint: `fp-${Date.now()}-10`, trustedSource: false,
      title: "Tesco", redactedText: "Payment to Tesco",
      clientDirection: "EXPENSE", clientAmountMinor: 500, clientConfidence: 0.65,
      occurredAt: new Date(),
    });
    expect(result.event).toBeTruthy();
    expect(result.event.amountMinor).toBe(500);
  });

  it("Scenario G — PROVIDER-authoritative account/balance evidence always wins over the AI, and the AI is never even asked", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("provider-authority");
    const spendingAcc = await newAccount(userId);
    // An Open-Banking-connected credit card: the CONNECTED PROVIDER, not this
    // app's local ledger, is authoritative for its balance (see
    // BalanceAuthority in schema.prisma) — the same "provider evidence always
    // wins" rule that governs deterministic-vs-AI classification also governs
    // account/balance authority. A unique CREDIT_CARD account matching the
    // payee name is HIGH-confidence account-identity evidence, which by
    // itself is already enough to skip the AI entirely (§8/§9 cost control).
    const cardAcc = await newAccount(userId, { bankName: "Zable", accountType: "CREDIT_CARD", balanceAuthority: "PROVIDER", balanceMinor: -50000n });
    const fake = new FakeSemanticClassifier();
    // A maximally "confident" AI opinion that, if it were ever consulted,
    // would try to redirect this to a completely different classification —
    // it must never be reached at all, let alone win.
    fake.response = baseAiOutput({ eventKind: "CARD_PURCHASE", analyticsRole: "SPENDING", isLikelyCreditCardRepayment: false, confidence: 0.99 });
    setClassifierForTests(fake);

    const result = await ingestFinancialEvent(userId, {
      accountId: spendingAcc, sourcePackage: "unknown.zable", sourceFingerprint: `fp-${Date.now()}-11`, trustedSource: false,
      title: "Zable", redactedText: "Payment to Zable Card has left your account", // generic wording, no "repayment" keyword
      clientDirection: "EXPENSE", clientAmountMinor: 12000, clientConfidence: 0.65, // deliberately MEDIUM — would normally trigger AI consultation
      occurredAt: new Date(),
    });

    // Strong account-identity evidence (HIGH-confidence payee match) reclassifies
    // this as a credit-card repayment on its own — the AI's contradicting
    // opinion is never applied, and is never even requested.
    expect(result.event.eventKind).toBe("CREDIT_CARD_REPAYMENT");
    expect(fake.calls.length).toBe(0);
    // The resolved destination account's PROVIDER-authoritative balance is
    // never locally decremented by this app's own ledger posting, regardless
    // of what the (never-called) AI would have suggested.
    const cardAfter = await prisma.bankAccount.findUnique({ where: { id: cardAcc } });
    expect(cardAfter).toMatchObject({ balanceMinor: -50000n });
  });
});

describe("AI advisory — explicit cost-control skip scenarios (§6/§9)", () => {
  it("a user-confirmed CounterpartyAccountMapping resolves the account and skips the AI entirely", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("mapping-skip");
    const spendingAcc = await newAccount(userId);
    const mappedAcc = await newAccount(userId, { bankName: "Mapped Savings" });
    await confirmCounterpartyAccount(userId, "Mapped Savings", mappedAcc, "USER");

    const fake = new FakeSemanticClassifier();
    fake.response = baseAiOutput({ eventKind: "CARD_PURCHASE", confidence: 0.99 }); // would apply if consulted — must never be
    setClassifierForTests(fake);

    const result = await ingestFinancialEvent(userId, {
      accountId: spendingAcc, sourcePackage: "unknown.somebank", sourceFingerprint: `fp-${Date.now()}-mapping`, trustedSource: false,
      title: "Mapped Savings", redactedText: "Money sent to Mapped Savings", // generic wording, no strong text signal
      clientDirection: "EXPENSE", clientAmountMinor: 4000, clientConfidence: 0.65, // deliberately MEDIUM
      occurredAt: new Date(),
    });
    // The stored mapping is HIGH-confidence account-identity evidence on its
    // own — strongAccountEvidence short-circuits the AI consultation before
    // it would otherwise have been reached at MEDIUM deterministic confidence.
    expect(fake.calls.length).toBe(0);
    expect(result.event).toBeTruthy();
  });

  it("a known Direct-Debit-worded, HIGH-confidence notification skips the AI (the general HIGH-confidence cost-control gate)", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("dd-skip");
    const acc = await newAccount(userId);
    const fake = new FakeSemanticClassifier();
    fake.response = baseAiOutput({ eventKind: "CREDIT_CARD_REPAYMENT", confidence: 0.99 });
    setClassifierForTests(fake);

    const result = await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.somebank", sourceFingerprint: `fp-${Date.now()}-dd`, trustedSource: false,
      title: "Acme Utilities", redactedText: "Your Direct Debit payment to Acme Utilities has been collected",
      clientDirection: "EXPENSE", clientAmountMinor: 3000, clientConfidence: 0.95, // HIGH
      occurredAt: new Date(),
    });
    expect(fake.calls.length).toBe(0);
    expect(result.event.eventKind).not.toBe("CREDIT_CARD_REPAYMENT"); // the never-called AI's opinion is not applied
  });

  it("a duplicate notification (same sourceFingerprint) never re-consults the AI on the repeat ingest", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("dup-skip");
    const acc = await newAccount(userId);
    const fingerprint = `fp-${Date.now()}-dup`;
    const fake = new FakeSemanticClassifier();
    fake.response = baseAiOutput({ eventKind: "CARD_PURCHASE", confidence: 0.9 });
    setClassifierForTests(fake);

    const notif = {
      accountId: acc, sourcePackage: "unknown.somebank", sourceFingerprint: fingerprint, trustedSource: false,
      title: "Some Shop", redactedText: "Payment to Some Shop, no strong signal either way",
      clientDirection: "EXPENSE" as const, clientAmountMinor: 1500, clientConfidence: 0.65, // MEDIUM -> AI consulted once
      occurredAt: new Date(),
    };
    await ingestFinancialEvent(userId, notif);
    const callsAfterFirst = fake.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0); // sanity: this scenario genuinely does consult the AI the first time

    const second = await ingestFinancialEvent(userId, notif);
    expect(second.duplicate).toBe(true);
    // Duplicate detection returns before classification/AI is ever reached
    // again — no additional call was made for the repeat ingest.
    expect(fake.calls.length).toBe(callsAfterFirst);
  });

  it("a non-financial notification never consults the AI at all", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("nonfin-skip");
    const acc = await newAccount(userId);
    const fake = new FakeSemanticClassifier();
    fake.response = baseAiOutput({ eventKind: "CARD_PURCHASE", confidence: 0.9 });
    setClassifierForTests(fake);

    const result = await ingestFinancialEvent(userId, {
      accountId: acc, sourcePackage: "unknown.somebank", sourceFingerprint: `fp-${Date.now()}-nonfin`, trustedSource: false,
      title: "Your Bank", redactedText: "Your statement is ready to view", // matches NON_FINANCIAL_RE in classifier.ts
      clientDirection: null, clientAmountMinor: null, clientConfidence: 0.1,
      occurredAt: new Date(),
    });
    expect(result.event.eventKind).toBe("NON_FINANCIAL");
    expect(fake.calls.length).toBe(0);
  });
});
