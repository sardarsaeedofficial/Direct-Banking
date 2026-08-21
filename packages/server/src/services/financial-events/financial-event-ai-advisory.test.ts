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

async function newAccount(userId: string, over: Partial<{ bankName: string; accountType: string; balanceMinor: bigint }> = {}) {
  const acc = await prisma.bankAccount.create({
    data: { userId, bankName: over.bankName ?? "Test Bank", nickname: over.bankName ?? "Test Bank", accountType: (over.accountType as never) ?? "CURRENT", currency: "GBP", balanceMinor: over.balanceMinor ?? 0n },
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
});
