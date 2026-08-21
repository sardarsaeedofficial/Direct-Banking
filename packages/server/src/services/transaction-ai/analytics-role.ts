import type { FinEventKind, FinEventLifecycle, ClientDirection } from "../financial-events/classifier.js";

// ---------------------------------------------------------------------------
// analyticsRoleFor — Transaction Intelligence Engine §1
//
// Pure mapping from (eventKind, direction, lifecycle, internal-transfer hint)
// to the ANALYTICS dimension — deliberately separate from eventKind
// (economic KIND) and lifecycle (settlement state). Unlike those two,
// analyticsRole is explicitly revisable: a provisional INCOME can become
// INTERNAL_TRANSFER once a matching debit is found, without ever having
// "locked in" as income in the meantime (see internal-transfer.service.ts's
// reconcileUnmatchedTransfers()).
// ---------------------------------------------------------------------------

export type AnalyticsRoleValue = "SPENDING" | "INCOME" | "INTERNAL_TRANSFER" | "LIABILITY_REPAYMENT" | "REFUND" | "IGNORE" | "REVIEW";

export interface AnalyticsRoleInput {
  eventKind: FinEventKind;
  expectedDirection: ClientDirection | null;
  lifecycle: FinEventLifecycle;
  /** Set when account-identity evidence suggests (but has not yet confirmed)
   *  that the counterparty is one of the user's own accounts. */
  isInternalTransferCandidate?: boolean;
  /** Set once pairing/manual confirmation has actually resolved this as an
   *  internal transfer — takes priority over every other signal. */
  isConfirmedInternalTransfer?: boolean;
}

export interface AnalyticsRoleResult {
  role: AnalyticsRoleValue;
  reason: string;
}

const NO_MONEY_MOVED_LIFECYCLES: ReadonlySet<FinEventLifecycle> = new Set(["UPCOMING", "DECLINED", "FAILED", "CANCELLED", "UNKNOWN"]);

export function analyticsRoleFor(input: AnalyticsRoleInput): AnalyticsRoleResult {
  if (input.isConfirmedInternalTransfer) {
    return { role: "INTERNAL_TRANSFER", reason: "Confirmed as a transfer between your own accounts" };
  }
  if (NO_MONEY_MOVED_LIFECYCLES.has(input.lifecycle)) {
    return { role: "IGNORE", reason: "No money has moved yet, or the payment did not go through" };
  }
  if (input.eventKind === "CREDIT_CARD_REPAYMENT") {
    return { role: "LIABILITY_REPAYMENT", reason: "A repayment toward a credit-card balance — the original purchases were already counted as spending" };
  }
  if (input.eventKind === "REFUND" || input.lifecycle === "REFUNDED") {
    return { role: "REFUND", reason: "A refund of a previous purchase" };
  }
  if (input.eventKind === "REVERSAL") {
    return { role: "IGNORE", reason: "A reversal of a payment that never completed" };
  }
  if (input.eventKind === "BALANCE_INFORMATION" || input.eventKind === "NON_FINANCIAL") {
    return { role: "IGNORE", reason: "Not a transaction" };
  }
  if (input.isInternalTransferCandidate) {
    return { role: "REVIEW", reason: "Possibly a transfer between your own accounts — awaiting confirmation" };
  }
  if (input.expectedDirection === "INCOME") return { role: "INCOME", reason: "Money received into this account" };
  if (input.expectedDirection === "EXPENSE") return { role: "SPENDING", reason: "Money spent from this account" };
  if (input.expectedDirection === "TRANSFER") return { role: "INTERNAL_TRANSFER", reason: "A transfer between accounts" };
  return { role: "REVIEW", reason: "Classification is uncertain" };
}
