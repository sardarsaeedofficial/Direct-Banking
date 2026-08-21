import { describe, expect, it } from "vitest";
import { aiReasonCodes } from "./explainability.js";
import type { ClassifierOutput } from "./types.js";

function output(over: Partial<ClassifierOutput> = {}): ClassifierOutput {
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
    confidence: 0.8,
    // Deliberately includes model free text — must never leak into the codes.
    reasons: ["The model's own chain-of-thought-adjacent phrasing that must never be persisted"],
    ...over,
  };
}

describe("aiReasonCodes — app-owned codes only, never the model's own text", () => {
  it("credit-card repayment support -> AI_SUPPORTS_CREDIT_CARD_REPAYMENT", () => {
    expect(aiReasonCodes(output({ isLikelyCreditCardRepayment: true }))).toContain("AI_SUPPORTS_CREDIT_CARD_REPAYMENT");
  });

  it("internal transfer support -> AI_SUPPORTS_INTERNAL_TRANSFER", () => {
    expect(aiReasonCodes(output({ isLikelyInternalTransfer: true }))).toContain("AI_SUPPORTS_INTERNAL_TRANSFER");
  });

  it("Direct Debit support -> AI_SUPPORTS_DIRECT_DEBIT", () => {
    expect(aiReasonCodes(output({ isLikelyDirectDebit: true }))).toContain("AI_SUPPORTS_DIRECT_DEBIT");
  });

  it("income analytics role -> AI_SUPPORTS_INCOME", () => {
    expect(aiReasonCodes(output({ analyticsRole: "INCOME" }))).toContain("AI_SUPPORTS_INCOME");
  });

  it("a DD-collected credit-card repayment yields both codes together", () => {
    const codes = aiReasonCodes(output({ isLikelyCreditCardRepayment: true, isLikelyDirectDebit: true, paymentRail: "DIRECT_DEBIT" }));
    expect(codes).toContain("AI_SUPPORTS_CREDIT_CARD_REPAYMENT");
    expect(codes).toContain("AI_SUPPORTS_DIRECT_DEBIT");
  });

  it("NEVER includes the model's own free-text reasons, chain-of-thought, or any string not in the fixed code set", () => {
    const codes = aiReasonCodes(output({ isLikelyCreditCardRepayment: true, reasons: ["Some arbitrary explanation the model wrote"] }));
    for (const code of codes) {
      expect(code).not.toContain("Some arbitrary explanation");
      expect(code).toMatch(/^AI_[A-Z_]+$/); // fixed, short, application-owned shape only
    }
  });

  it("falls back to a generic code when no specific signal is set, never an empty list", () => {
    const codes = aiReasonCodes(output());
    expect(codes.length).toBeGreaterThan(0);
    expect(codes.every((c) => /^AI_[A-Z_]+$/.test(c))).toBe(true);
  });
});
