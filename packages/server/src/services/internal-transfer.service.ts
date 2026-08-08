import type { Prisma, TransferConfidence } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";

// ---------------------------------------------------------------------------
// Internal-transfer detection
//
// A transfer between two accounts the SAME user owns must not be counted as
// real income + real spending. Detection combines several signals and weights
// hard account-identity evidence above soft name matching. Name equality alone
// is never sufficient to auto-classify a transfer as internal.
// ---------------------------------------------------------------------------

const TITLES = new Set(["MR", "MRS", "MS", "MISS", "DR", "PROF", "SIR", "MX"]);

/** Normalise a personal/account-holder name for comparison. */
export function normaliseName(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ") // drop punctuation/digits
    .split(/\s+/)
    .filter((t) => t && !TITLES.has(t))
    .join(" ")
    .trim();
}

function tokens(raw: string | null | undefined): string[] {
  return normaliseName(raw).split(" ").filter(Boolean);
}

/** One token is the initial of the other (e.g. "S" ~ "SARDAR"). */
function initialCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === 1 && b.startsWith(a)) return true;
  if (b.length === 1 && a.startsWith(b)) return true;
  return false;
}

/**
 * Similarity of two names in [0,1]. Requires the surname (last token) to match,
 * then rewards coverage of the shorter name's tokens by the longer one. Matches
 * made only via an initial are capped below an exact match. Handles:
 *   "Sardar Saeed" ~ "SARDAR SAEED" ~ "S Saeed" ~ "Sardar M Saeed".
 */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;

  const surnameA = ta[ta.length - 1];
  const surnameB = tb[tb.length - 1];
  const surnameExact = surnameA === surnameB;
  if (!surnameExact && !initialCompatible(surnameA, surnameB)) return 0;

  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const used = new Array(long.length).fill(false);
  let matched = 0;
  let anyInitialOnly = !surnameExact;
  for (const t of short) {
    let found = -1;
    let exact = false;
    for (let i = 0; i < long.length; i++) {
      if (used[i]) continue;
      if (long[i] === t) {
        found = i;
        exact = true;
        break;
      }
      if (found === -1 && initialCompatible(long[i], t)) found = i;
    }
    if (found >= 0) {
      used[found] = true;
      matched++;
      if (!exact) anyInitialOnly = true;
    }
  }

  const coverage = matched / short.length;
  if (coverage >= 1) return anyInitialOnly ? 0.85 : 1;
  if (coverage >= 0.5) return 0.6;
  return 0.4;
}

export interface TransferSide {
  accountId: string;
  accountHolderName?: string | null;
  direction: "INCOME" | "EXPENSE" | "TRANSFER";
  amountMinor: bigint;
  currency: string;
  bookedAt: Date;
  counterpartyName?: string | null; // recipientName for a debit, senderName for a credit
  counterpartyAccountId?: string | null; // when a notification named the other own-account
  counterpartyAccountHint?: string | null;
  paymentReference?: string | null;
}

export interface PairScore {
  confidence: TransferConfidence;
  score: number;
}

const MIN = 60 * 1000;

function isOpposite(a: TransferSide, b: TransferSide): boolean {
  if (a.direction === "TRANSFER" || b.direction === "TRANSFER") return true;
  return (a.direction === "EXPENSE" && b.direction === "INCOME") || (a.direction === "INCOME" && b.direction === "EXPENSE");
}

/**
 * Score two sides as an internal transfer. Hard gates (same currency, equal
 * amount, different account, opposite direction) must all hold. Both sides are
 * assumed to be accounts owned by the same user (the caller only ever pairs the
 * user's own transactions).
 */
export function scorePair(a: TransferSide, b: TransferSide): PairScore {
  if (a.currency !== b.currency) return { confidence: "NOT_INTERNAL", score: 0 };
  if (a.amountMinor !== b.amountMinor) return { confidence: "NOT_INTERNAL", score: 0 };
  if (a.accountId === b.accountId) return { confidence: "NOT_INTERNAL", score: 0 };
  if (!isOpposite(a, b)) return { confidence: "NOT_INTERNAL", score: 0 };

  // Structural base: two of the user's own accounts, equal & opposite, same currency.
  let score = 0.3;

  const dt = Math.abs(a.bookedAt.getTime() - b.bookedAt.getTime());
  if (dt <= 2 * MIN) score += 0.4;
  else if (dt <= 10 * MIN) score += 0.3;
  else if (dt <= 120 * MIN) score += 0.2;
  else if (dt <= 24 * 60 * MIN) score += 0.1;

  // Hard account-identity evidence (weighted above name matching).
  const accIdEvidence =
    (!!a.counterpartyAccountId && a.counterpartyAccountId === b.accountId) ||
    (!!b.counterpartyAccountId && b.counterpartyAccountId === a.accountId);
  if (accIdEvidence) score += 0.4;

  // Soft name evidence (counterparty names to each other / to holder names).
  const nameScore = Math.max(
    nameSimilarity(a.counterpartyName, b.counterpartyName),
    nameSimilarity(a.counterpartyName, b.accountHolderName),
    nameSimilarity(b.counterpartyName, a.accountHolderName),
    nameSimilarity(a.accountHolderName, b.accountHolderName),
  );
  score += 0.3 * nameScore;

  if (
    a.paymentReference &&
    b.paymentReference &&
    a.paymentReference.trim().toLowerCase() === b.paymentReference.trim().toLowerCase()
  ) {
    score += 0.1;
  }

  score = Math.min(score, 1);
  const confidence: TransferConfidence =
    score >= 0.9 ? "CONFIRMED" : score >= 0.7 ? "HIGH" : score >= 0.45 ? "POSSIBLE" : "NOT_INTERNAL";
  return { confidence, score };
}

/** Only CONFIRMED/HIGH are treated as internal automatically. */
export function isAutoInternal(c: TransferConfidence): boolean {
  return c === "CONFIRMED" || c === "HIGH";
}

type TxnRow = {
  id: string;
  accountId: string;
  direction: "INCOME" | "EXPENSE" | "TRANSFER";
  amountMinor: bigint;
  currency: string;
  bookedAt: Date;
  senderName: string | null;
  recipientName: string | null;
  senderAccountId: string | null;
  recipientAccountId: string | null;
  senderAccountHint: string | null;
  recipientAccountHint: string | null;
  paymentReference: string | null;
  transactionType: string | null;
  internalTransferGroupId: string | null;
  account: { accountHolderName: string | null; nickname: string | null; bankName: string | null };
};

function toSide(t: TxnRow): TransferSide {
  const credit = t.direction === "INCOME";
  return {
    accountId: t.accountId,
    accountHolderName: t.account.accountHolderName,
    direction: t.direction,
    amountMinor: t.amountMinor,
    currency: t.currency,
    bookedAt: t.bookedAt,
    counterpartyName: credit ? t.senderName : t.recipientName,
    counterpartyAccountId: credit ? t.senderAccountId : t.recipientAccountId,
    counterpartyAccountHint: credit ? t.senderAccountHint : t.recipientAccountHint,
    paymentReference: t.paymentReference,
  };
}

const TXN_SELECT = {
  id: true,
  accountId: true,
  direction: true,
  amountMinor: true,
  currency: true,
  bookedAt: true,
  senderName: true,
  recipientName: true,
  senderAccountId: true,
  recipientAccountId: true,
  senderAccountHint: true,
  recipientAccountHint: true,
  paymentReference: true,
  transactionType: true,
  internalTransferGroupId: true,
  account: { select: { accountHolderName: true, nickname: true, bankName: true } },
} satisfies Prisma.TransactionSelect;

/**
 * After a transaction is created (or its classification is being re-evaluated),
 * look for the opposite side on another of the user's accounts and pair them
 * when the match is strong. When only one side is known but its counterparty
 * name matches one of the user's own account holders, flag it POSSIBLE so the
 * user can confirm and link an account — never auto-classify on a name alone.
 *
 * Returns the resulting confidence for the given transaction (or NOT_INTERNAL).
 * Runs on the supplied transaction client so it can be part of an atomic import.
 */
export async function detectAndPairInternalTransfer(
  userId: string,
  transactionId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<TransferConfidence> {
  const txn = (await client.transaction.findFirst({
    where: { id: transactionId, userId },
    select: TXN_SELECT,
  })) as TxnRow | null;
  if (!txn) return "NOT_INTERNAL";
  // Already paired, or a coarse transfer already handled by transferAccountId.
  if (txn.internalTransferGroupId || txn.transactionType === "INTERNAL_TRANSFER") return "CONFIRMED";

  const windowMs = 24 * 60 * MIN;
  const candidates = (await client.transaction.findMany({
    where: {
      userId,
      id: { not: txn.id },
      parentId: null,
      currency: txn.currency,
      amountMinor: txn.amountMinor,
      accountId: { not: txn.accountId },
      // Already-paired transfers always carry a group id, so this also excludes
      // existing INTERNAL_TRANSFER rows (without wrongly dropping null-typed legacy rows).
      internalTransferGroupId: null,
      status: { in: ["COMPLETED", "PENDING"] },
      bookedAt: { gte: new Date(txn.bookedAt.getTime() - windowMs), lte: new Date(txn.bookedAt.getTime() + windowMs) },
    },
    select: TXN_SELECT,
    orderBy: { bookedAt: "desc" },
    take: 25,
  })) as TxnRow[];

  const sideA = toSide(txn);
  let best: { row: TxnRow; result: PairScore } | null = null;
  for (const c of candidates) {
    const result = scorePair(sideA, toSide(c));
    if (result.confidence === "NOT_INTERNAL") continue;
    if (!best || result.score > best.result.score) best = { row: c, result };
  }

  if (best && isAutoInternal(best.result.confidence)) {
    const groupId = randomUUID();
    const other = best.row;
    // Enrich both sides with the counterpart bank name for a clear detail view.
    await client.transaction.update({
      where: { id: txn.id },
      data: {
        transactionType: "INTERNAL_TRANSFER",
        internalTransferGroupId: groupId,
        internalTransferConfidence: best.result.confidence,
        recipientBankName: txn.direction === "INCOME" ? undefined : other.account.bankName ?? undefined,
        senderBankName: txn.direction === "INCOME" ? other.account.bankName ?? undefined : undefined,
      },
    });
    await client.transaction.update({
      where: { id: other.id },
      data: {
        transactionType: "INTERNAL_TRANSFER",
        internalTransferGroupId: groupId,
        internalTransferConfidence: best.result.confidence,
      },
    });
    return best.result.confidence;
  }

  if (best && best.result.confidence === "POSSIBLE") {
    // Visible for user confirmation; classification stays normal until confirmed.
    await client.transaction.update({ where: { id: txn.id }, data: { internalTransferConfidence: "POSSIBLE" } });
    return "POSSIBLE";
  }

  // Single-sided: counterparty name matches one of the user's OWN account holders.
  const counterpartyName = txn.direction === "INCOME" ? txn.senderName : txn.recipientName;
  if (counterpartyName) {
    const ownAccounts = await client.bankAccount.findMany({
      where: { userId, isArchived: false, id: { not: txn.accountId } },
      select: { accountHolderName: true },
    });
    const nameHit = ownAccounts.some((a) => nameSimilarity(counterpartyName, a.accountHolderName) >= 0.85);
    if (nameHit) {
      await client.transaction.update({ where: { id: txn.id }, data: { internalTransferConfidence: "POSSIBLE" } });
      return "POSSIBLE";
    }
  }

  return "NOT_INTERNAL";
}
