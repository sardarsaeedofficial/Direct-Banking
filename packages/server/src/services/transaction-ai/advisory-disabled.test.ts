import { describe, expect, it } from "vitest";
import { FakeSemanticClassifier } from "./fake-classifier.js";

// Deliberately a SEPARATE file (and so, under --pool=forks, a separate
// process) from advisory.test.ts: env.ts's parsed config is computed once
// per process at first import, so "AI disabled" and "AI enabled" cannot
// both be exercised by toggling process.env within a single already-loaded
// process — each variant needs its own fresh module graph. This file never
// sets TRANSACTION_AI_ENABLED, so it exercises the true default (false).

describe("classifyAdvisory — AI disabled fallback (default configuration)", () => {
  it("returns null instantly and never calls the provider when TRANSACTION_AI_ENABLED is unset (defaults false)", async () => {
    process.env.MOBILE_JWT_SECRET ||= "test-mobile-secret-0123456789abcdef";
    process.env.SESSION_SECRET ||= "test-session-secret-0123456789abcdef";
    process.env.DATABASE_URL ||= "postgresql://user:pass@localhost:5432/test";
    const { classifyAdvisory } = await import("./advisory.js");
    const { setClassifierForTests } = await import("./registry.js");
    const { transactionAiEnabled } = await import("./registry.js");
    expect(transactionAiEnabled()).toBe(false);

    const fake = new FakeSemanticClassifier();
    fake.response = {
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
      reasons: ["test"],
    };
    setClassifierForTests(fake);

    const result = await classifyAdvisory({
      sourceInstitution: null,
      sourcePackage: null,
      title: "Zable",
      sanitizedText: "test",
      amountMinor: 100,
      currency: "GBP",
      direction: "EXPENSE",
      accountHint: null,
      candidateOwnedAccounts: [],
      deterministicClassification: { eventKind: "CARD_PURCHASE", paymentRail: null, confidenceLevel: "LOW" },
    });
    expect(result).toBeNull();
    expect(fake.calls.length).toBe(0);
  });
});
