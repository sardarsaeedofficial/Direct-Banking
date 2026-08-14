import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { reverseTransactionBalance } from "./transactions.service.js";
import { recordCorrection } from "./corrections.service.js";
import { detectSubscriptions } from "./recurring.service.js";

// Reconciliation Review Centre (Phase 5). Surfaces uncertain matches the engine
// deliberately did NOT auto-apply, so nothing is hidden in backend-only data:
//  - possible duplicates (incl. uncertain statement matches)
//  - possible internal transfers
//  - possible subscriptions
//  - uncategorized transactions
// plus the merge / keep-separate actions.

export class ReviewError extends Error {}

function orderedPair(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

interface TxnBrief {
  id: string;
  description: string;
  merchantName: string | null;
  amountMinor: string;
  direction: string;
  currency: string;
  bookedAt: string | null;
  source: string;
  accountName: string | null;
}

function brief(t: {
  id: string;
  description: string;
  merchantName: string | null;
  amountMinor: bigint;
  direction: string;
  currency: string;
  bookedAt: Date | null;
  source: string;
  account?: { nickname: string | null } | null;
}): TxnBrief {
  return {
    id: t.id,
    description: t.description,
    merchantName: t.merchantName,
    amountMinor: t.amountMinor.toString(),
    direction: t.direction,
    currency: t.currency,
    bookedAt: t.bookedAt ? t.bookedAt.toISOString() : null,
    source: t.source,
    accountName: t.account?.nickname ?? null,
  };
}

const TXN_BRIEF_SELECT = {
  id: true,
  description: true,
  merchantName: true,
  amountMinor: true,
  direction: true,
  currency: true,
  bookedAt: true,
  source: true,
  account: { select: { nickname: true } },
} satisfies Prisma.TransactionSelect;

/** Everything awaiting human review, grouped by kind. */
export async function getReviewCentre(userId: string) {
  // Pairs the user explicitly kept separate must never resurface.
  const keptSeparate = await prisma.reconciliationDecision.findMany({
    where: { userId, decision: "KEEP_SEPARATE" },
    select: { transactionAId: true, transactionBId: true },
  });
  const keptSet = new Set(keptSeparate.map((k) => `${k.transactionAId}:${k.transactionBId}`));

  const possibleDupRows = await prisma.transaction.findMany({
    where: { userId, possibleDuplicateOfId: { not: null }, status: { not: "CANCELLED" } },
    select: { ...TXN_BRIEF_SELECT, possibleDuplicateOfId: true, possibleDuplicateOf: { select: TXN_BRIEF_SELECT } },
    orderBy: { bookedAt: "desc" },
    take: 100,
  });

  const dupPairs = possibleDupRows
    .filter((t) => t.possibleDuplicateOf)
    .filter((t) => {
      const [a, b] = orderedPair(t.id, t.possibleDuplicateOfId!);
      return !keptSet.has(`${a}:${b}`);
    })
    .map((t) => ({ transaction: brief(t), match: brief(t.possibleDuplicateOf!) }));

  const possibleDuplicates = dupPairs.filter((p) => p.transaction.source !== "STATEMENT_IMPORT");
  const uncertainStatementMatches = dupPairs.filter((p) => p.transaction.source === "STATEMENT_IMPORT");

  const possibleInternalTransfers = (
    await prisma.transaction.findMany({
      where: { userId, internalTransferConfidence: "POSSIBLE", internalTransferGroupId: null, status: { not: "CANCELLED" } },
      select: TXN_BRIEF_SELECT,
      orderBy: { bookedAt: "desc" },
      take: 50,
    })
  ).map(brief);

  const uncategorized = (
    await prisma.transaction.findMany({
      where: {
        userId,
        categoryId: null,
        status: { not: "CANCELLED" },
        parentId: null,
        transactionType: { not: "INTERNAL_TRANSFER" },
      },
      select: TXN_BRIEF_SELECT,
      orderBy: { bookedAt: "desc" },
      take: 50,
    })
  ).map(brief);

  // Possible subscriptions (reviewable strength only) from the Phase 4 detector.
  const suggestions = (await detectSubscriptions(userId)).filter((s) => s.confidence === "POSSIBLE" || s.confidence === "HIGH_CONFIDENCE");
  const possibleSubscriptions = suggestions.map((s) => ({
    merchantId: s.merchantId,
    merchantName: s.merchantName,
    averageAmountMinor: String(s.averageAmountMinor),
    intervalDays: s.medianIntervalDays,
    occurrences: s.occurrences,
    confidence: s.confidence,
  }));

  return {
    possibleDuplicates,
    uncertainStatementMatches,
    possibleInternalTransfers,
    possibleSubscriptions,
    uncategorized,
    counts: {
      possibleDuplicates: possibleDuplicates.length,
      uncertainStatementMatches: uncertainStatementMatches.length,
      possibleInternalTransfers: possibleInternalTransfers.length,
      possibleSubscriptions: possibleSubscriptions.length,
      uncategorized: uncategorized.length,
    },
  };
}

/**
 * Merge a possible-duplicate transaction INTO its canonical counterpart: move the
 * duplicate's evidence onto the canonical transaction (preserving one canonical row
 * + combined evidence), safely reverse the duplicate's balance effect, then remove
 * it. Ownership is enforced on both sides.
 */
export async function mergeDuplicate(userId: string, duplicateId: string) {
  return prisma.$transaction(async (tx) => {
    const dup = await tx.transaction.findFirst({
      where: { id: duplicateId, userId },
      select: { id: true, possibleDuplicateOfId: true, accountId: true, direction: true, amountMinor: true, transferAccountId: true, balanceApplied: true },
    });
    if (!dup) throw new ReviewError("Transaction not found");
    if (!dup.possibleDuplicateOfId) throw new ReviewError("Transaction has no duplicate to merge into");
    const canonical = await tx.transaction.findFirst({ where: { id: dup.possibleDuplicateOfId, userId }, select: { id: true } });
    if (!canonical) throw new ReviewError("Canonical transaction not found");

    // Move evidence onto the canonical transaction (skip rows that would collide).
    const dupEvidence = await tx.transactionEvidence.findMany({ where: { transactionId: dup.id } });
    for (const ev of dupEvidence) {
      const clashes = await tx.transactionEvidence.findFirst({
        where: {
          transactionId: canonical.id,
          OR: [
            ev.provider && ev.providerTransactionId ? { provider: ev.provider, providerTransactionId: ev.providerTransactionId } : { id: "__none__" },
            ev.statementImportId && ev.rowFingerprint ? { statementImportId: ev.statementImportId, rowFingerprint: ev.rowFingerprint } : { id: "__none__" },
          ],
        },
        select: { id: true },
      });
      if (clashes) await tx.transactionEvidence.delete({ where: { id: ev.id } });
      else await tx.transactionEvidence.update({ where: { id: ev.id }, data: { transactionId: canonical.id } });
    }

    // Reverse the duplicate's balance effect (no-op unless it was applied), then delete it.
    await reverseTransactionBalance(tx, dup);
    await tx.transaction.updateMany({ where: { possibleDuplicateOfId: dup.id }, data: { possibleDuplicateOfId: canonical.id } });
    await tx.transaction.delete({ where: { id: dup.id } });

    await recordCorrection(userId, { transactionId: canonical.id, action: "DUPLICATE_MERGE", before: { mergedId: dup.id }, after: { canonicalId: canonical.id } }, tx);
    return { canonicalId: canonical.id, mergedId: dup.id };
  });
}

/**
 * Record a permanent "these are NOT the same" decision so the pair is never
 * auto-flagged again, and clear the pending duplicate link.
 */
export async function keepSeparate(userId: string, transactionId: string) {
  return prisma.$transaction(async (tx) => {
    const txn = await tx.transaction.findFirst({ where: { id: transactionId, userId }, select: { id: true, possibleDuplicateOfId: true } });
    if (!txn) throw new ReviewError("Transaction not found");
    if (!txn.possibleDuplicateOfId) throw new ReviewError("Transaction has no pending duplicate");
    const [a, b] = orderedPair(txn.id, txn.possibleDuplicateOfId);
    await tx.reconciliationDecision.upsert({
      where: { userId_transactionAId_transactionBId: { userId, transactionAId: a, transactionBId: b } },
      update: {},
      create: { userId, transactionAId: a, transactionBId: b, decision: "KEEP_SEPARATE" },
    });
    await tx.transaction.update({ where: { id: txn.id }, data: { possibleDuplicateOfId: null } });
    await recordCorrection(userId, { transactionId: txn.id, action: "DUPLICATE_KEEP_SEPARATE", before: { possibleDuplicateOfId: b }, after: { keptSeparate: true } }, tx);
    return { keptSeparate: [a, b] };
  });
}
