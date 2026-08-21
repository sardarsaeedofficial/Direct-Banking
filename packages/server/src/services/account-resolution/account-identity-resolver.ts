import type { AccountType, Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { normaliseCompany } from "../direct-debit.service.js";
import { normaliseName, nameSimilarity } from "../internal-transfer.service.js";

// ---------------------------------------------------------------------------
// AccountIdentityResolver — Transaction Intelligence Engine
//
// Resolves "which of the user's OWN accounts does this evidence point to?"
// with a strict evidence hierarchy. Never fabricates an owned account from
// weak evidence alone, and never lets an AI guess stand in for real evidence
// — the AI classifier (services/transaction-ai/) may SUGGEST a
// sourceAccountCandidate/destinationAccountCandidate, but this resolver only
// ever accepts a candidate that is independently backed by real evidence
// (an id/last4/mapping/uniqueness the AI cannot fabricate on its own).
//
// Evidence hierarchy (strongest first — see README of this round's spec):
//   1. EXACT_ACCOUNT_ID            — the caller already knows the id
//   2. EXACT_PROVIDER_ACCOUNT_ID   — Plaid/TrueLayer account id match
//   3. EXACT_LAST4_AND_INSTITUTION — card/account last-4 + matching bank name
//   4. USER_CONFIRMED_MAPPING      — a persisted CounterpartyAccountMapping
//   5. UNIQUE_AT_INSTITUTION       — exactly one owned account at that bank
//      (optionally narrowed to a desired account type, e.g. CREDIT_CARD)
// Weaker, advisory-only evidence (never sufficient alone to auto-resolve):
//   6. ACCOUNT_HOLDER_NAME_SIMILARITY
//   7. COUNTERPARTY_TEXT_SIMILARITY
// Anything else, or a tie between multiple equally-plausible candidates,
// resolves to nothing — ambiguous: true — and the caller must route to
// Review rather than guess.
// ---------------------------------------------------------------------------

export type AccountEvidenceTier =
  | "EXACT_ACCOUNT_ID"
  | "EXACT_PROVIDER_ACCOUNT_ID"
  | "EXACT_LAST4_AND_INSTITUTION"
  | "USER_CONFIRMED_MAPPING"
  | "UNIQUE_AT_INSTITUTION"
  | "ACCOUNT_HOLDER_NAME_SIMILARITY"
  | "COUNTERPARTY_TEXT_SIMILARITY"
  | "NONE";

export type ResolutionConfidence = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface AccountResolutionInput {
  userId: string;
  accountId?: string | null;
  providerAccountId?: string | null;
  /** Free-text institution/bank name hint, e.g. "Zable", "Capital One", "Monzo". */
  institutionHint?: string | null;
  last4?: string | null;
  /** Free-text counterparty/payee/sender name from the notification/statement. */
  counterpartyText?: string | null;
  /** Only consider owned accounts of this type (e.g. CREDIT_CARD for a repayment payee). */
  desiredAccountType?: AccountType | null;
  client?: Prisma.TransactionClient;
}

export interface AccountResolutionResult {
  accountId: string | null;
  confidence: ResolutionConfidence;
  evidenceTier: AccountEvidenceTier;
  ambiguous: boolean;
  candidateAccountIds: string[];
  reasons: string[];
}

const NONE_RESULT: AccountResolutionResult = {
  accountId: null,
  confidence: "NONE",
  evidenceTier: "NONE",
  ambiguous: false,
  candidateAccountIds: [],
  reasons: [],
};

interface OwnedAccount {
  id: string;
  bankName: string;
  nickname: string;
  accountType: AccountType;
  lastFour: string | null;
  providerAccountId: string | null;
  accountHolderName: string | null;
  isArchived: boolean;
}

const OWNED_ACCOUNT_SELECT = {
  id: true,
  bankName: true,
  nickname: true,
  accountType: true,
  lastFour: true,
  providerAccountId: true,
  accountHolderName: true,
  isArchived: true,
} satisfies Prisma.BankAccountSelect;

function institutionMatches(account: OwnedAccount, hint: string): boolean {
  const h = normaliseCompany(hint);
  if (!h) return false;
  return normaliseCompany(account.bankName) === h || normaliseCompany(account.nickname) === h || normaliseCompany(account.bankName).includes(h) || h.includes(normaliseCompany(account.bankName));
}

/**
 * Resolve one owned-account identity for a piece of financial evidence.
 * Deterministic, side-effect-free (aside from the caller-supplied client's
 * transaction scope) and safe to call speculatively. Always scoped to
 * `userId` — never resolves to another user's account.
 */
export async function resolveOwnedAccount(input: AccountResolutionInput): Promise<AccountResolutionResult> {
  const client = input.client ?? prisma;

  // Tier 1: caller already knows the exact account id — just confirm ownership.
  if (input.accountId) {
    const owned = await client.bankAccount.findFirst({ where: { id: input.accountId, userId: input.userId }, select: { id: true } });
    if (owned) {
      return { accountId: owned.id, confidence: "HIGH", evidenceTier: "EXACT_ACCOUNT_ID", ambiguous: false, candidateAccountIds: [owned.id], reasons: ["Exact account id supplied and owned by you"] };
    }
  }

  // Tier 2: exact provider account id (Plaid/TrueLayer) — unambiguous by construction.
  if (input.providerAccountId) {
    const owned = await client.bankAccount.findFirst({ where: { providerAccountId: input.providerAccountId, userId: input.userId }, select: { id: true } });
    if (owned) {
      return { accountId: owned.id, confidence: "HIGH", evidenceTier: "EXACT_PROVIDER_ACCOUNT_ID", ambiguous: false, candidateAccountIds: [owned.id], reasons: ["Matched your bank's own provider account id"] };
    }
  }

  const owned = (await client.bankAccount.findMany({
    where: { userId: input.userId, isArchived: false },
    select: OWNED_ACCOUNT_SELECT,
  })) as OwnedAccount[];
  if (owned.length === 0) return NONE_RESULT;

  const typed = input.desiredAccountType ? owned.filter((a) => a.accountType === input.desiredAccountType) : owned;

  // Tier 3: exact last-4 + matching institution name.
  if (input.last4 && input.institutionHint) {
    const hits = typed.filter((a) => a.lastFour === input.last4 && institutionMatches(a, input.institutionHint!));
    if (hits.length === 1) {
      return { accountId: hits[0]!.id, confidence: "HIGH", evidenceTier: "EXACT_LAST4_AND_INSTITUTION", ambiguous: false, candidateAccountIds: [hits[0]!.id], reasons: [`Card/account ending ${input.last4} at ${input.institutionHint} matches exactly one of your accounts`] };
    }
    if (hits.length > 1) {
      return { accountId: null, confidence: "NONE", evidenceTier: "EXACT_LAST4_AND_INSTITUTION", ambiguous: true, candidateAccountIds: hits.map((h) => h.id), reasons: [`More than one of your accounts ends ${input.last4} at ${input.institutionHint}`] };
    }
  }

  // Tier 4: a previously user-confirmed (or system-learned) counterparty mapping.
  if (input.counterpartyText) {
    const key = normaliseCompany(input.counterpartyText);
    if (key) {
      const mapping = await client.counterpartyAccountMapping.findUnique({
        where: { userId_counterpartyKey: { userId: input.userId, counterpartyKey: key } },
        select: { accountId: true, confirmedBy: true },
      });
      if (mapping) {
        const stillOwned = owned.find((a) => a.id === mapping.accountId);
        if (stillOwned && (!input.desiredAccountType || stillOwned.accountType === input.desiredAccountType)) {
          return {
            accountId: mapping.accountId,
            confidence: "HIGH",
            evidenceTier: "USER_CONFIRMED_MAPPING",
            ambiguous: false,
            candidateAccountIds: [mapping.accountId],
            reasons: [mapping.confirmedBy === "USER" ? "You previously confirmed this counterparty belongs to this account" : "Learned from a previously confirmed match with this counterparty"],
          };
        }
      }
    }
  }

  // Tier 5: exactly one owned account (of the desired type, if given) at the named institution.
  if (input.institutionHint) {
    const hits = typed.filter((a) => institutionMatches(a, input.institutionHint!));
    if (hits.length === 1) {
      return { accountId: hits[0]!.id, confidence: "HIGH", evidenceTier: "UNIQUE_AT_INSTITUTION", ambiguous: false, candidateAccountIds: [hits[0]!.id], reasons: [`You have exactly one${input.desiredAccountType ? ` ${input.desiredAccountType.toLowerCase().replace("_", " ")}` : ""} account at ${input.institutionHint}`] };
    }
    if (hits.length > 1) {
      return { accountId: null, confidence: "NONE", evidenceTier: "UNIQUE_AT_INSTITUTION", ambiguous: true, candidateAccountIds: hits.map((h) => h.id), reasons: [`You have more than one account at ${input.institutionHint} — which one this belongs to isn't clear`] };
    }
  }

  // Tier 6 (weak, advisory only): account-holder name vs. counterparty text.
  if (input.counterpartyText) {
    const scored = typed
      .map((a) => ({ a, score: nameSimilarity(input.counterpartyText, a.accountHolderName) }))
      .filter((s) => s.score >= 0.85)
      .sort((x, y) => y.score - x.score);
    if (scored.length === 1) {
      return { accountId: scored[0]!.a.id, confidence: "LOW", evidenceTier: "ACCOUNT_HOLDER_NAME_SIMILARITY", ambiguous: false, candidateAccountIds: [scored[0]!.a.id], reasons: ["The name on this payment closely matches one of your account holder names — please confirm"] };
    }
    if (scored.length > 1) {
      return { accountId: null, confidence: "NONE", evidenceTier: "ACCOUNT_HOLDER_NAME_SIMILARITY", ambiguous: true, candidateAccountIds: scored.map((s) => s.a.id), reasons: ["The name on this payment matches more than one of your accounts"] };
    }
  }

  return NONE_RESULT;
}

/** Normalise free text into the same key CounterpartyAccountMapping stores/looks up by. */
export function counterpartyKey(text: string | null | undefined): string {
  return normaliseCompany(text ?? "");
}

/**
 * Persist a user-confirmed (or system-learned) counterparty -> account
 * mapping. Idempotent: re-confirming the same counterparty updates the
 * existing mapping (a user correcting an earlier mistaken confirmation is
 * the common case, not an error).
 */
export async function confirmCounterpartyAccount(
  userId: string,
  counterpartyText: string,
  accountId: string,
  confirmedBy: "USER" | "SYSTEM" = "USER",
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<{ counterpartyKey: string; accountId: string } | null> {
  const key = counterpartyKey(counterpartyText);
  if (!key) return null;
  const owned = await client.bankAccount.findFirst({ where: { id: accountId, userId }, select: { id: true } });
  if (!owned) return null;
  await client.counterpartyAccountMapping.upsert({
    where: { userId_counterpartyKey: { userId, counterpartyKey: key } },
    update: { accountId, confirmedBy },
    create: { userId, counterpartyKey: key, accountId, confirmedBy },
  });
  return { counterpartyKey: key, accountId };
}

/** Also exported for reuse by callers that already have a normalised name. */
export { normaliseName };
