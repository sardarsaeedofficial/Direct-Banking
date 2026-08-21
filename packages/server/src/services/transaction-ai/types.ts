import { z } from "zod";

// ---------------------------------------------------------------------------
// TransactionSemanticClassifier — Transaction Intelligence Engine, AI layer
//
// PROVIDER-NEUTRAL interface: business logic never imports a specific AI
// vendor's SDK or types. A concrete provider adapter (not included here —
// none is required for this app to function; see registry.ts) implements
// this interface and is wired in only via TRANSACTION_AI_PROVIDER.
//
// CRITICAL SAFETY RULES (see docs on financial-event.service.ts for how
// these are enforced, not just documented):
//   - The AI is ADVISORY ONLY. It classifies; it never posts, mutates,
//     deletes, pairs, or settles anything. LedgerPostingPolicy/deterministic
//     validation remains the sole authority over the ledger.
//   - Every AI response is validated against classifierOutputSchema before
//     any field of it is read. An invalid/malformed response is discarded
//     entirely — never partially trusted.
//   - The input is structured and minimal (classifierInputSchema) — never a
//     free-form dump of the notification or account data. See redaction.ts
//     for what is stripped before a real input is ever built.
// ---------------------------------------------------------------------------

export const finEventKindValues = [
  "CARD_PURCHASE", "BANK_TRANSFER", "DIRECT_DEBIT", "CREDIT_CARD_REPAYMENT",
  "STANDING_ORDER", "SUBSCRIPTION", "RECURRING_CARD", "CASH_WITHDRAWAL",
  "FEE", "REFUND", "REVERSAL", "BALANCE_INFORMATION", "NON_FINANCIAL", "UNKNOWN",
] as const;

export const paymentRailValues = ["DIRECT_DEBIT", "CARD", "TRANSFER", "STANDING_ORDER", "CASH", "OTHER"] as const;

export const analyticsRoleValues = ["SPENDING", "INCOME", "INTERNAL_TRANSFER", "LIABILITY_REPAYMENT", "REFUND", "IGNORE", "REVIEW"] as const;

/** A candidate owned account the deterministic layer has already identified —
 *  the AI is only ever shown ids/labels the app itself resolved, never asked
 *  to invent one. */
export const candidateAccountSchema = z.object({
  accountId: z.string().min(1),
  label: z.string().min(1).max(80), // e.g. "Monzo current", "Zable credit card" — never a full account number
  accountType: z.string().min(1).max(40),
});
export type CandidateAccount = z.infer<typeof candidateAccountSchema>;

/**
 * Structured, minimal, already-redacted input. Every field here is either a
 * short label/hint the deterministic pipeline already produced, or a
 * sanitised text snippet (see redaction.ts) — never a raw notification body,
 * never a secret, never a full account/card number.
 */
export const classifierInputSchema = z.object({
  sourceInstitution: z.string().max(80).nullable().optional(),
  sourcePackage: z.string().max(160).nullable().optional(),
  title: z.string().max(160),
  sanitizedText: z.string().max(600),
  amountMinor: z.number().int().nonnegative().nullable(),
  currency: z.string().max(8),
  direction: z.enum(["INCOME", "EXPENSE", "TRANSFER"]).nullable(),
  accountHint: z.string().max(40).nullable().optional(), // e.g. last-4, never a full number
  candidateOwnedAccounts: z.array(candidateAccountSchema).max(20),
  knownMerchant: z.string().max(120).nullable().optional(),
  knownMandates: z.array(z.string().max(120)).max(10).optional(),
  recentRelatedEvents: z.array(z.string().max(120)).max(10).optional(),
  deterministicClassification: z.object({
    eventKind: z.enum(finEventKindValues),
    paymentRail: z.enum(paymentRailValues).nullable(),
    confidenceLevel: z.enum(["HIGH", "MEDIUM", "LOW"]),
  }),
});
export type ClassifierInput = z.infer<typeof classifierInputSchema>;

/**
 * STRICT structured output only. Every field is validated; nothing free-form
 * (no chain-of-thought, no arbitrary prose) is ever accepted — `reasons` is a
 * short array of plain phrases suitable for direct display, capped in
 * length/count specifically so a provider can't smuggle a large narrative
 * through it.
 */
export const classifierOutputSchema = z.object({
  eventKind: z.enum(finEventKindValues),
  paymentRail: z.enum(paymentRailValues).nullable(),
  analyticsRole: z.enum(analyticsRoleValues),
  sourceAccountCandidate: z.string().max(80).nullable(),
  destinationAccountCandidate: z.string().max(80).nullable(),
  merchantNormalized: z.string().max(120).nullable(),
  isLikelyInternalTransfer: z.boolean(),
  isLikelyCreditCardRepayment: z.boolean(),
  isLikelyDirectDebit: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string().max(140)).max(6),
});
export type ClassifierOutput = z.infer<typeof classifierOutputSchema>;

/** A provider-neutral AI semantic classifier. Implementations are entirely
 *  optional — see null-classifier.ts (default, disabled) and
 *  fake-classifier.ts (test double). Any real provider adapter lives outside
 *  this repo's required dependency surface. */
export interface TransactionSemanticClassifier {
  readonly name: string;
  classify(input: ClassifierInput): Promise<ClassifierOutput | null>;
}

/** Parse + validate an untrusted AI response. Returns null (never throws) on
 *  any schema violation — the caller's contract is simply "discard on
 *  invalid", never "half-trust a partial object". */
export function parseClassifierOutput(raw: unknown): ClassifierOutput | null {
  const result = classifierOutputSchema.safeParse(raw);
  return result.success ? result.data : null;
}
