import { createHash } from "node:crypto";
import type { Prisma, TxnDirection } from "@prisma/client";
import { prisma } from "../db.js";
import { parseStatement, UnsupportedStatementError, type StatementFileType } from "./statement/index.js";
import { rowFingerprint } from "./statement/normalise.js";
import { createTransaction } from "./transactions.service.js";
import { detectAndPairInternalTransfer } from "./internal-transfer.service.js";
import { detectDirectDebit } from "./direct-debit.service.js";
import { normaliseMerchant } from "./merchant-normalise.service.js";

// StatementImportService (Phase 5).
//
// Fallback import for banks without notifications/Open Banking. The flow is
// upload → parse → preview → reconcile → confirm → import: parsed rows are staged
// as StatementCandidate rows and reconciled against the existing ledger BEFORE
// anything is written. Raw uploaded files are never persisted.

const MIN = 60_000;
const MATCH_WINDOW_MS = 4 * 24 * 60 * MIN;

export class ImportOwnershipError extends Error {}
export { UnsupportedStatementError } from "./statement/index.js";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Loose merchant similarity used to converge a statement row with an existing row. */
function descSimilar(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normaliseMerchant(a ?? "");
  const nb = normaliseMerchant(b ?? "");
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.startsWith(nb) || nb.startsWith(na)) return true;
  const fa = na.split(" ")[0] ?? "";
  const fb = nb.split(" ")[0] ?? "";
  return fa.length >= 3 && fa === fb;
}

export interface CreateImportInput {
  accountId: string;
  filename: string;
  fileType: StatementFileType;
  buffer: Buffer;
  institution?: string | null;
}

/**
 * Upload + parse a statement. Idempotent per (user, account, file): re-uploading the
 * same bytes returns the existing session instead of creating duplicates. Unparseable
 * files are recorded as FAILED (never invented). Reconciliation scoring runs so the
 * preview can show new / already-recorded / needs-review counts.
 */
export async function createStatementImport(userId: string, input: CreateImportInput) {
  const account = await prisma.bankAccount.findFirst({ where: { id: input.accountId, userId }, select: { id: true } });
  if (!account) throw new ImportOwnershipError("Account not found");

  const fileHash = sha256(input.buffer);

  // Double-import protection: same file to the same account is idempotent.
  const existing = await prisma.statementImport.findUnique({
    where: { userId_accountId_fileHash: { userId, accountId: input.accountId, fileHash } },
  });
  if (existing) return existing;

  let parsed;
  try {
    parsed = parseStatement(input.fileType, input.buffer);
  } catch (e) {
    if (e instanceof UnsupportedStatementError) {
      return prisma.statementImport.create({
        data: {
          userId,
          accountId: input.accountId,
          filename: input.filename,
          fileType: input.fileType,
          fileHash,
          institution: input.institution ?? null,
          status: "FAILED",
          error: "Unsupported statement format",
        },
      });
    }
    throw e;
  }

  const created = await prisma.$transaction(async (tx) => {
    const imp = await tx.statementImport.create({
      data: {
        userId,
        accountId: input.accountId,
        filename: input.filename,
        fileType: input.fileType,
        fileHash,
        institution: input.institution ?? parsed.institution ?? null,
        status: "PARSED",
        transactionCount: parsed.rowsWithFingerprint.length,
        periodStart: parsed.periodStart ?? null,
        periodEnd: parsed.periodEnd ?? null,
      },
    });
    await tx.statementCandidate.createMany({
      data: parsed.rowsWithFingerprint.map((r) => ({
        statementImportId: imp.id,
        userId,
        rowIndex: r.rowIndex,
        bookedAt: r.bookedAt,
        timeText: r.timeText ?? null,
        amountMinor: BigInt(r.amountMinor),
        currency: r.currency,
        direction: r.direction as TxnDirection,
        description: r.description,
        merchantName: r.merchantName ?? null,
        senderName: r.senderName ?? null,
        recipientName: r.recipientName ?? null,
        reference: r.reference ?? null,
        balanceAfterMinor: r.balanceAfterMinor != null ? BigInt(r.balanceAfterMinor) : null,
        fingerprint: r.fingerprint,
      })),
    });
    return imp;
  });

  await reconcileStatement(userId, created.id);
  return prisma.statementImport.findUnique({ where: { id: created.id } });
}

interface CandRow {
  id: string;
  rowIndex: number;
  bookedAt: Date;
  amountMinor: bigint;
  currency: string;
  direction: TxnDirection;
  description: string;
  reference: string | null;
  fingerprint: string;
  excluded: boolean;
}

/**
 * Score each candidate against the existing ledger without writing transactions:
 *   - DUPLICATE: a transaction on this account already carries this row's evidence
 *     (idempotent re-import / overlapping statements).
 *   - MATCHED: a same-day, same-amount, similar-description transaction exists
 *     (a notification/Plaid row) — importing will attach statement evidence, not a
 *     second transaction.
 *   - REVIEW: a weaker same-amount match a human should confirm.
 *   - NEW: no match — importing creates a canonical transaction.
 */
export async function reconcileStatement(userId: string, importId: string) {
  const imp = await prisma.statementImport.findFirst({ where: { id: importId, userId }, select: { id: true, accountId: true } });
  if (!imp) throw new ImportOwnershipError("Import not found");

  const candidates = (await prisma.statementCandidate.findMany({
    where: { statementImportId: importId },
    orderBy: { rowIndex: "asc" },
  })) as unknown as CandRow[];

  let newCount = 0;
  let dupCount = 0;
  let reviewCount = 0;
  let matchedCount = 0;

  for (const cand of candidates) {
    if (cand.excluded) continue;

    // 1) Already-imported evidence with the same fingerprint on this account.
    const evDup = await prisma.transactionEvidence.findFirst({
      where: { rowFingerprint: cand.fingerprint, transaction: { userId, accountId: imp.accountId } },
      select: { transactionId: true },
    });
    if (evDup) {
      await prisma.statementCandidate.update({ where: { id: cand.id }, data: { reconStatus: "DUPLICATE", matchedTransactionId: evDup.transactionId } });
      dupCount++;
      continue;
    }

    // 2) Same account/amount/direction/currency near the same day.
    const booked = cand.bookedAt;
    const txns = await prisma.transaction.findMany({
      where: {
        userId,
        accountId: imp.accountId,
        parentId: null,
        currency: cand.currency,
        amountMinor: cand.amountMinor,
        direction: cand.direction,
        status: { in: ["COMPLETED", "PENDING"] },
        bookedAt: { gte: new Date(booked.getTime() - MATCH_WINDOW_MS), lte: new Date(booked.getTime() + MATCH_WINDOW_MS) },
      },
      select: { id: true, bookedAt: true, merchantName: true, description: true, paymentReference: true },
      orderBy: { bookedAt: "desc" },
      take: 20,
    });

    let best: { id: string; strong: boolean } | null = null;
    for (const t of txns) {
      const sameDay = Math.abs(t.bookedAt.getTime() - booked.getTime()) <= 36 * 60 * MIN;
      const similar = descSimilar(cand.description, t.merchantName ?? t.description) ||
        (!!cand.reference && !!t.paymentReference && cand.reference.trim().toLowerCase() === t.paymentReference.trim().toLowerCase());
      const strong = sameDay && (similar || txns.length === 1);
      if (strong) { best = { id: t.id, strong: true }; break; }
      if (!best) best = { id: t.id, strong: false };
    }

    if (best && best.strong) {
      await prisma.statementCandidate.update({ where: { id: cand.id }, data: { reconStatus: "MATCHED", matchedTransactionId: best.id } });
      matchedCount++;
    } else if (best) {
      await prisma.statementCandidate.update({ where: { id: cand.id }, data: { reconStatus: "REVIEW", matchedTransactionId: best.id } });
      reviewCount++;
    } else {
      await prisma.statementCandidate.update({ where: { id: cand.id }, data: { reconStatus: "NEW", matchedTransactionId: null } });
      newCount++;
    }
  }

  const status = reviewCount > 0 ? "REVIEW_REQUIRED" : "PARSED";
  await prisma.statementImport.update({
    where: { id: importId },
    data: {
      status,
      duplicateCount: dupCount,
      reviewCount,
      // "new" for preview purposes counts rows that will create a transaction.
      transactionCount: candidates.length,
    },
  });

  return { newCount, dupCount, reviewCount, matchedCount };
}

/** Add statement evidence to a canonical transaction (idempotent per import+fingerprint). */
async function addStatementEvidence(
  client: Prisma.TransactionClient,
  transactionId: string,
  e: { statementImportId: string; rowFingerprint: string; rowIndex: number },
): Promise<void> {
  await client.transactionEvidence.upsert({
    where: { statementImportId_rowFingerprint: { statementImportId: e.statementImportId, rowFingerprint: e.rowFingerprint } },
    update: { transactionId, observedAt: new Date() },
    create: {
      transactionId,
      sourceType: "STATEMENT_IMPORT",
      statementImportId: e.statementImportId,
      rowFingerprint: e.rowFingerprint,
      rowIndex: e.rowIndex,
    },
  });
}

export interface ImportOptions {
  excludeRowIndexes?: number[];
  // Explicit opt-in to rebuild a LEDGER account's balance from imported history.
  // Off by default — historical rows are recorded with balanceApplied=false so they
  // never silently move an already-established balance.
  rebuildBalance?: boolean;
}

/**
 * Commit an import: create canonical transactions for NEW rows, attach statement
 * evidence to MATCHED rows (one canonical transaction, two evidence records), skip
 * DUPLICATEs, and create REVIEW rows flagged as possible duplicates for the Review
 * Centre. Historical rows use balanceApplied=false unless the user opts to rebuild.
 */
export async function importStatement(userId: string, importId: string, opts: ImportOptions = {}) {
  const imp = await prisma.statementImport.findFirst({
    where: { id: importId, userId },
    include: { account: { select: { id: true, currency: true, balanceAuthority: true } } },
  });
  if (!imp) throw new ImportOwnershipError("Import not found");

  const exclude = new Set(opts.excludeRowIndexes ?? []);
  const candidates = (await prisma.statementCandidate.findMany({
    where: { statementImportId: importId },
    orderBy: { rowIndex: "asc" },
  })) as unknown as (CandRow & { reconStatus: string; matchedTransactionId: string | null })[];

  // LEDGER accounts: historical import never moves the balance unless rebuild opt-in.
  // PROVIDER accounts: balance is provider-authoritative, so never applied.
  const applyBalance = opts.rebuildBalance === true && imp.account.balanceAuthority !== "PROVIDER";

  let imported = 0;
  let matched = 0;
  let duplicates = 0;
  let review = 0;
  let skipped = 0;

  for (const cand of candidates) {
    // Idempotent re-import: rows already committed are never created twice.
    if (cand.reconStatus === "IMPORTED") continue;
    if (exclude.has(cand.rowIndex) || cand.excluded) {
      await prisma.statementCandidate.update({ where: { id: cand.id }, data: { reconStatus: "EXCLUDED", excluded: true } });
      skipped++;
      continue;
    }

    if (cand.reconStatus === "DUPLICATE" && cand.matchedTransactionId) {
      // Already recorded — attach statement evidence for provenance, no new row.
      await prisma.$transaction((tx) => addStatementEvidence(tx, cand.matchedTransactionId!, { statementImportId: imp.id, rowFingerprint: cand.fingerprint, rowIndex: cand.rowIndex }));
      duplicates++;
      continue;
    }

    if (cand.reconStatus === "MATCHED" && cand.matchedTransactionId) {
      await prisma.$transaction((tx) => addStatementEvidence(tx, cand.matchedTransactionId!, { statementImportId: imp.id, rowFingerprint: cand.fingerprint, rowIndex: cand.rowIndex }));
      await prisma.statementCandidate.update({ where: { id: cand.id }, data: { reconStatus: "MATCHED" } });
      matched++;
      continue;
    }

    // NEW or REVIEW → create a canonical transaction (REVIEW also flags a possible dup).
    const isReview = cand.reconStatus === "REVIEW";
    const txnId = await prisma.$transaction(async (tx) => {
      const created = await createTransaction(
        userId,
        {
          accountId: imp.accountId,
          direction: cand.direction,
          status: "COMPLETED",
          source: "STATEMENT_IMPORT",
          amountMinor: Number(cand.amountMinor),
          currency: cand.currency,
          bookedAt: cand.bookedAt,
          occurredAt: cand.bookedAt,
          description: cand.description,
          merchantName: cand.description,
          paymentReference: cand.reference ?? undefined,
          applyBalance,
        },
        tx,
      );
      await addStatementEvidence(tx, created.id, { statementImportId: imp.id, rowFingerprint: cand.fingerprint, rowIndex: cand.rowIndex });
      if (isReview && cand.matchedTransactionId) {
        await tx.transaction.update({ where: { id: created.id }, data: { possibleDuplicateOfId: cand.matchedTransactionId } });
      } else {
        // Classification pipeline (same as notification/Plaid): transfer → DD.
        const conf = await detectAndPairInternalTransfer(userId, created.id, tx);
        if (conf !== "CONFIRMED" && conf !== "HIGH") {
          await detectDirectDebit(
            userId,
            created.id,
            {
              merchant: cand.description,
              text: cand.description,
              amountMinor: Number(cand.amountMinor),
              accountId: imp.accountId,
              bookedAt: cand.bookedAt,
              direction: cand.direction,
              reference: cand.reference,
            },
            tx,
          );
        }
      }
      return created.id;
    });

    await prisma.statementCandidate.update({
      where: { id: cand.id },
      data: { reconStatus: isReview ? "REVIEW" : "IMPORTED", matchedTransactionId: txnId },
    });
    if (isReview) review++;
    else imported++;
  }

  const anyImported = imported + matched + duplicates > 0;
  const status = skipped > 0 && (imported === 0 && matched === 0) ? "PARTIALLY_IMPORTED" : anyImported || review > 0 ? "IMPORTED" : "PARTIALLY_IMPORTED";
  await prisma.statementImport.update({
    where: { id: importId },
    data: {
      status: skipped > 0 && anyImported ? "PARTIALLY_IMPORTED" : status,
      importedCount: imported,
      duplicateCount: duplicates,
      reviewCount: review,
      completedAt: new Date(),
    },
  });

  return { imported, matched, duplicates, review, skipped, total: candidates.length };
}
