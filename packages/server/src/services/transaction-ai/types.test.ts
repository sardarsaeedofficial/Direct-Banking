import { describe, expect, it } from "vitest";
import { classifierOutputSchema, parseClassifierOutput } from "./types.js";

// Contract test (§4/§8): locks the AI's output shape down to exactly the
// advisory fields it is allowed to influence. If a future change ever widens
// classifierOutputSchema to include a ledger-affecting field, this test fails
// loudly instead of silently letting the AI acquire new authority.
const FORBIDDEN_OUTPUT_FIELDS = [
  "lifecycle", "amount", "amountMinor", "currency", "ledgerPosted", "posted",
  "balance", "balanceMinor", "accountId", "sourceAccountId", "destinationAccountId",
  "fromAccountId", "toAccountId", "transactionId", "id",
];

describe("classifierOutputSchema — advisory-only contract", () => {
  it("never defines a ledger-affecting field", () => {
    const shapeKeys = Object.keys(classifierOutputSchema.shape);
    for (const forbidden of FORBIDDEN_OUTPUT_FIELDS) {
      expect(shapeKeys).not.toContain(forbidden);
    }
  });

  it("exposes exactly the known advisory field set — no silent additions", () => {
    const shapeKeys = new Set(Object.keys(classifierOutputSchema.shape));
    expect(shapeKeys).toEqual(new Set([
      "eventKind", "paymentRail", "analyticsRole", "sourceAccountCandidate",
      "destinationAccountCandidate", "merchantNormalized", "isLikelyInternalTransfer",
      "isLikelyCreditCardRepayment", "isLikelyDirectDebit", "confidence", "reasons",
    ]));
  });

  it("parseClassifierOutput discards a response smuggling an extra ledger-affecting field alongside a valid shape", () => {
    // Zod's default (non-strict) object parsing strips unknown keys rather
    // than rejecting them — assert the surviving parsed object never carries
    // the smuggled field through, even though the call itself doesn't throw.
    const raw = {
      eventKind: "CARD_PURCHASE", paymentRail: null, analyticsRole: "SPENDING",
      sourceAccountCandidate: null, destinationAccountCandidate: null, merchantNormalized: null,
      isLikelyInternalTransfer: false, isLikelyCreditCardRepayment: false, isLikelyDirectDebit: false,
      confidence: 0.9, reasons: [],
      lifecycle: "COMPLETED", amountMinor: 999999, ledgerPosted: true, accountId: "acc-attacker-controlled",
    };
    const parsed = parseClassifierOutput(raw);
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("lifecycle");
    expect(parsed).not.toHaveProperty("amountMinor");
    expect(parsed).not.toHaveProperty("ledgerPosted");
    expect(parsed).not.toHaveProperty("accountId");
  });
});
