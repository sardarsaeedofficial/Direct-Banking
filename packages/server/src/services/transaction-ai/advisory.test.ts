import { beforeAll, afterEach, describe, expect, it } from "vitest";
import type { ClassifierInput, ClassifierOutput } from "./types.js";
import { FakeSemanticClassifier } from "./fake-classifier.js";

// classifyAdvisory()/classifyAndGrade() need TRANSACTION_AI_ENABLED=true to
// ever call the provider, so this file sets it BEFORE dynamically importing
// the env-dependent modules — the same pattern plaid.integration.test.ts
// uses for its own env-gated config.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let classifyAdvisory: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let classifyAndGrade: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let gradeAiOutput: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let setClassifierForTests: any;

beforeAll(async () => {
  process.env.TRANSACTION_AI_ENABLED = "true";
  process.env.MOBILE_JWT_SECRET ||= "test-mobile-secret-0123456789abcdef";
  process.env.SESSION_SECRET ||= "test-session-secret-0123456789abcdef";
  process.env.DATABASE_URL ||= "postgresql://user:pass@localhost:5432/test";
  const advisory = await import("./advisory.js");
  classifyAdvisory = advisory.classifyAdvisory;
  classifyAndGrade = advisory.classifyAndGrade;
  gradeAiOutput = advisory.gradeAiOutput;
  const registry = await import("./registry.js");
  setClassifierForTests = registry.setClassifierForTests;
});

afterEach(() => setClassifierForTests(null));

const input: ClassifierInput = {
  sourceInstitution: "Zable",
  sourcePackage: "unknown.zable",
  title: "Zable",
  sanitizedText: "Payment to Zable Card",
  amountMinor: 25443,
  currency: "GBP",
  direction: "EXPENSE",
  accountHint: null,
  candidateOwnedAccounts: [],
  knownMerchant: null,
  deterministicClassification: { eventKind: "CARD_PURCHASE", paymentRail: null, confidenceLevel: "LOW" },
};

const goodOutput: ClassifierOutput = {
  eventKind: "CREDIT_CARD_REPAYMENT",
  paymentRail: "DIRECT_DEBIT",
  analyticsRole: "LIABILITY_REPAYMENT",
  sourceAccountCandidate: null,
  destinationAccountCandidate: null,
  merchantNormalized: "Zable",
  isLikelyInternalTransfer: false,
  isLikelyCreditCardRepayment: true,
  isLikelyDirectDebit: true,
  confidence: 0.9,
  reasons: ["Payee matches a known credit-card provider"],
};

describe("classifyAdvisory — invalid AI response", () => {
  it("discards a schema-invalid response entirely rather than partially trusting it", async () => {
    const fake = new FakeSemanticClassifier();
    fake.rawResponseOverride = { eventKind: "NOT_A_REAL_KIND", confidence: "high" }; // wrong types
    setClassifierForTests(fake);
    const result = await classifyAdvisory(input);
    expect(result).toBeNull();
  });

  it("discards a response missing required fields", async () => {
    const fake = new FakeSemanticClassifier();
    fake.rawResponseOverride = { eventKind: "CARD_PURCHASE" }; // missing everything else
    setClassifierForTests(fake);
    const result = await classifyAdvisory(input);
    expect(result).toBeNull();
  });
});

describe("classifyAdvisory — AI timeout/error", () => {
  it("returns null (never throws) when the provider throws", async () => {
    const fake = new FakeSemanticClassifier();
    fake.throwError = new Error("provider unavailable");
    setClassifierForTests(fake);
    await expect(classifyAdvisory(input)).resolves.toBeNull();
  });

  it("returns null when the provider never resolves within the timeout", async () => {
    const fake = new FakeSemanticClassifier();
    fake.delayMs = 10_000; // far longer than the 4s advisory timeout
    fake.response = goodOutput;
    setClassifierForTests(fake);
    const result = await classifyAdvisory(input);
    expect(result).toBeNull();
  }, 15_000);
});

describe("gradeAiOutput — confidence thresholds", () => {
  it("HIGH deterministic confidence always ignores the AI, regardless of its confidence", () => {
    const decision = gradeAiOutput(goodOutput, "HIGH");
    expect(decision.action).toBe("IGNORE");
  });

  it("HIGH AI confidence + MEDIUM deterministic confidence allows automatic use", () => {
    const decision = gradeAiOutput(goodOutput, "MEDIUM");
    expect(decision.action).toBe("ALLOW_AUTOMATIC");
  });

  it("medium AI confidence (0.5-0.75) is a visible suggestion only, never automatic", () => {
    const decision = gradeAiOutput({ ...goodOutput, confidence: 0.6 }, "MEDIUM");
    expect(decision.action).toBe("SUGGEST");
  });

  it("low AI confidence is ignored entirely", () => {
    const decision = gradeAiOutput({ ...goodOutput, confidence: 0.2 }, "LOW");
    expect(decision.action).toBe("IGNORE");
  });

  it("a null AI output (disabled/error/invalid) always grades to IGNORE", () => {
    expect(gradeAiOutput(null, "LOW").action).toBe("IGNORE");
  });
});

describe("classifyAndGrade — never even calls the provider when deterministic confidence is already HIGH", () => {
  it("skips the provider call entirely for HIGH deterministic confidence", async () => {
    const fake = new FakeSemanticClassifier();
    fake.response = goodOutput;
    setClassifierForTests(fake);
    const decision = await classifyAndGrade(input, "HIGH");
    expect(decision.action).toBe("IGNORE");
    expect(fake.calls.length).toBe(0);
  });

  it("does call the provider for MEDIUM deterministic confidence", async () => {
    const fake = new FakeSemanticClassifier();
    fake.response = goodOutput;
    setClassifierForTests(fake);
    const decision = await classifyAndGrade(input, "MEDIUM");
    expect(decision.action).toBe("ALLOW_AUTOMATIC");
    expect(fake.calls.length).toBe(1);
  });
});
