import type { ClassifierOutput } from "./types.js";

// ---------------------------------------------------------------------------
// Explainability (§8/§6 of this round) — converts an AI classification into
// SHORT, APPLICATION-OWNED reason codes only. Deliberately reads ONLY the
// output's structured boolean/enum fields (isLikelyCreditCardRepayment,
// eventKind, etc.) — never the model's own free-text `reasons` array, which
// is never persisted or displayed. This is the one place in the codebase
// that is allowed to turn an AI opinion into a reason code; every other
// caller only ever sees the codes this function returns.
// ---------------------------------------------------------------------------

export function aiReasonCodes(output: ClassifierOutput): string[] {
  const codes: string[] = [];
  if (output.isLikelyCreditCardRepayment || output.eventKind === "CREDIT_CARD_REPAYMENT") codes.push("AI_SUPPORTS_CREDIT_CARD_REPAYMENT");
  if (output.isLikelyInternalTransfer) codes.push("AI_SUPPORTS_INTERNAL_TRANSFER");
  if (output.isLikelyDirectDebit || output.paymentRail === "DIRECT_DEBIT") codes.push("AI_SUPPORTS_DIRECT_DEBIT");
  if (output.analyticsRole === "INCOME") codes.push("AI_SUPPORTS_INCOME");
  if (output.analyticsRole === "SPENDING") codes.push("AI_SUPPORTS_SPENDING");
  if (output.analyticsRole === "REFUND") codes.push("AI_SUPPORTS_REFUND");
  if (codes.length === 0) codes.push("AI_CLASSIFICATION_PROVIDED");
  return codes;
}
