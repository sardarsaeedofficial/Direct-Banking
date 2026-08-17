import type { FinEventLifecycle, FinEventConfidenceLevel, LedgerImpact } from "@prisma/client";

// ---------------------------------------------------------------------------
// LedgerPostingPolicy — the single place that decides whether a FinancialEvent
// may affect the canonical ledger. No notification parser, bank-specific
// parser, or classifier may decide this directly; they only produce a
// lifecycle + confidence, and this policy turns that into a posting decision.
//
// Confidence policy (§19):
//   HIGH + COMPLETED + clear direction -> automatic ledger candidate
//   HIGH + UPCOMING                    -> automatic expected event (no post)
//   HIGH + DECLINED/FAILED             -> automatic non-posting event
//   MEDIUM                             -> Review / non-posting
//   LOW                                -> Review
//
// PROVIDER-authoritative accounts remain protected regardless of this policy:
// createTransaction() itself looks up BalanceAuthority and refuses to apply a
// balance effect for a PROVIDER account no matter what the caller passes
// (Phase 6 financial-integrity fix) — that guarantee is structural and this
// policy does not need to (and must not try to) duplicate it.
// ---------------------------------------------------------------------------

export interface PostingDecision {
  canPost: boolean;
  ledgerImpact: LedgerImpact;
  requiresReview: boolean;
  reason: string;
}

export function decidePosting(event: { lifecycle: FinEventLifecycle; confidenceLevel: FinEventConfidenceLevel }): PostingDecision {
  switch (event.lifecycle) {
    case "UPCOMING":
      return { canPost: false, ledgerImpact: "NONE", requiresReview: false, reason: "UPCOMING_NO_POST" };
    case "DECLINED":
      return { canPost: false, ledgerImpact: "NONE", requiresReview: false, reason: "DECLINED_NO_POST" };
    case "FAILED":
      return { canPost: false, ledgerImpact: "NONE", requiresReview: false, reason: "FAILED_NO_POST" };
    case "CANCELLED":
      return { canPost: false, ledgerImpact: "NONE", requiresReview: false, reason: "CANCELLED_NO_POST" };
    case "UNKNOWN":
      return { canPost: false, ledgerImpact: "NONE", requiresReview: true, reason: "UNKNOWN_REVIEW" };
    case "PENDING":
      // Visible as pending where the UI chooses to show it, but it never
      // mutates the booked balance (§12).
      return { canPost: false, ledgerImpact: "PENDING_VISIBLE", requiresReview: false, reason: "PENDING_VISIBLE_ONLY" };
    case "COMPLETED":
      if (event.confidenceLevel === "HIGH") {
        return { canPost: true, ledgerImpact: "POSTED", requiresReview: false, reason: "HIGH_CONFIDENCE_COMPLETED" };
      }
      // MEDIUM/LOW confidence never auto-posts, even when the lifecycle looks
      // COMPLETED — an authoritative provider (Plaid/TrueLayer) confirming the
      // same movement goes through its own already-trusted reconciliation
      // path, not this notification-derived one.
      return { canPost: false, ledgerImpact: "NONE", requiresReview: true, reason: "LOW_MEDIUM_CONFIDENCE_REVIEW" };
    case "REFUNDED":
      return { canPost: true, ledgerImpact: "CORRECTED", requiresReview: false, reason: "REFUNDED_RECONCILE" };
    case "REVERSED":
      return { canPost: true, ledgerImpact: "CORRECTED", requiresReview: false, reason: "REVERSED_RECONCILE" };
    default:
      return { canPost: false, ledgerImpact: "NONE", requiresReview: true, reason: "UNRECOGNISED_LIFECYCLE" };
  }
}

// Controlled lifecycle transitions (§9). A transition not listed here is
// rejected — the caller must create a new, separate FinancialEvent instead of
// illegally mutating a terminal one (this is exactly what distinguishes "the
// same payment attempt updating its own state" from "a brand-new attempt",
// §25).
const ALLOWED_TRANSITIONS: Record<FinEventLifecycle, FinEventLifecycle[]> = {
  UPCOMING: ["COMPLETED", "CANCELLED", "PENDING", "UNKNOWN"],
  PENDING: ["COMPLETED", "DECLINED", "REVERSED", "FAILED", "UNKNOWN"],
  COMPLETED: ["REVERSED", "REFUNDED"],
  DECLINED: [],
  FAILED: [],
  CANCELLED: [],
  REVERSED: [],
  REFUNDED: [],
  UNKNOWN: ["UPCOMING", "PENDING", "COMPLETED", "DECLINED", "FAILED", "CANCELLED", "REVERSED", "REFUNDED"],
};

export function canTransition(from: FinEventLifecycle, to: FinEventLifecycle): boolean {
  if (from === to) return true; // idempotent re-classification, not a transition
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
