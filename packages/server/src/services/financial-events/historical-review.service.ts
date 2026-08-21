import type { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { classifyNotification, type FinEventLifecycle } from "./classifier.js";
import { reverseTransactionBalance } from "../transactions.service.js";
import { KNOWN_BANKS } from "../notification-import.service.js";
import { HttpError } from "../../middleware/error.js";
import { resolveOwnedAccount } from "../account-resolution/account-identity-resolver.js";
import { normaliseCompany } from "../direct-debit.service.js";

// ---------------------------------------------------------------------------
// Historical suspicious-record review (§27)
//
// Existing installations may already contain notification-derived
// transactions that were posted under the OLD "trusted source + amount =
// completed" assumption — an upcoming Direct Debit or credit-card repayment
// recorded as a completed expense, or a declined payment recorded as a
// successful one. This module NEVER silently mutates those historical rows.
// It only identifies candidates by re-running the current classifier against
// the notification's own original wording, and exposes them for the user to
// review and confirm via the existing Review Centre / TransactionCorrection
// audit trail — the same pattern already used for merge/duplicate/transfer
// corrections.
// ---------------------------------------------------------------------------

export interface SuspiciousCandidate {
  transactionId: string;
  notificationImportId: string;
  currentAmountMinor: string;
  currentDirection: string;
  bookedAt: string;
  merchantName: string | null;
  suspectedLifecycle: FinEventLifecycle;
  suspectedEventKind: string;
  reasonCode: string;
  originalText: string;
}

/**
 * Scan this user's NOTIFICATION-sourced, currently-COMPLETED transactions
 * that still have their original notification evidence, and re-classify each
 * one with the CURRENT rules. A transaction is flagged when re-classification
 * would now produce a non-COMPLETED lifecycle (UPCOMING/DECLINED/FAILED/
 * CANCELLED) — i.e. a state that should never have been posted under today's
 * rules. Read-only: nothing is changed here.
 */
export async function findSuspiciousLegacyTransactions(userId: string, client: Prisma.TransactionClient = prisma): Promise<SuspiciousCandidate[]> {
  const imports = await client.notificationImport.findMany({
    where: { userId, approvedTransactionId: { not: null }, status: "APPROVED" },
    orderBy: { receivedAt: "desc" },
    take: 500, // bounded scan — a full backlog re-evaluation is an explicit, separate operation, never automatic on every load
  });
  if (imports.length === 0) return [];

  const txnIds = imports.map((i) => i.approvedTransactionId!).filter(Boolean);
  const txns = await client.transaction.findMany({
    where: { id: { in: txnIds }, userId, status: "COMPLETED", source: "NOTIFICATION" },
  });
  const txnById = new Map(txns.map((t) => [t.id, t]));

  const candidates: SuspiciousCandidate[] = [];
  for (const imp of imports) {
    const txn = imp.approvedTransactionId ? txnById.get(imp.approvedTransactionId) : undefined;
    if (!txn) continue;

    const trustedSource = Object.prototype.hasOwnProperty.call(KNOWN_BANKS, imp.sourcePackage);
    const reclassified = classifyNotification({
      sourcePackage: imp.sourcePackage,
      trustedSource,
      title: imp.title,
      text: imp.redactedText ?? imp.message,
      merchantHint: imp.parsedMerchant,
      // Deliberately NOT passing the original clientDirection/clientConfidence:
      // the whole point of this scan is to check what the CURRENT text-based
      // rules say on their own, not to reproduce the old client-declared
      // fallback that produced the (possibly wrong) original posting.
      occurredAt: imp.receivedAt,
    });

    if (reclassified.isFinancial && reclassified.lifecycle !== "COMPLETED" && reclassified.lifecycle !== "UNKNOWN") {
      candidates.push({
        transactionId: txn.id,
        notificationImportId: imp.id,
        currentAmountMinor: txn.amountMinor.toString(),
        currentDirection: txn.direction,
        bookedAt: txn.bookedAt.toISOString(),
        merchantName: txn.merchantName,
        suspectedLifecycle: reclassified.lifecycle,
        suspectedEventKind: reclassified.eventKind,
        reasonCode: reclassified.reasonCode,
        originalText: imp.redactedText ?? imp.message,
      });
    }
  }
  return candidates;
}

/**
 * Apply a user-confirmed correction for one suspicious legacy transaction:
 * reverses its balance effect exactly once (only if it was actually applied —
 * reverseTransactionBalance() is itself a no-op otherwise), marks it
 * CANCELLED (the existing, already-tested "excluded from spending/balance"
 * state — see NON_TRANSFER_WHERE), and records a TransactionCorrection audit
 * row with the before/after state. The original transaction row is never
 * deleted — full history is retained.
 */
export async function applyHistoricalCorrection(
  userId: string,
  transactionId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<{ transactionId: string; correctionId: string }> {
  const txn = await client.transaction.findFirst({ where: { id: transactionId, userId } });
  if (!txn) throw new HttpError(404, "Transaction not found");
  if (txn.status === "CANCELLED") throw new HttpError(409, "Already corrected");

  const before = { status: txn.status, balanceApplied: txn.balanceApplied, direction: txn.direction, amountMinor: txn.amountMinor.toString() };

  await reverseTransactionBalance(client, txn);
  await client.transaction.update({ where: { id: txn.id }, data: { status: "CANCELLED", balanceApplied: false } });

  const correction = await client.transactionCorrection.create({
    data: {
      userId,
      transactionId: txn.id,
      action: "LIFECYCLE_RECLASSIFY",
      beforeJson: before,
      afterJson: { status: "CANCELLED", balanceApplied: false, reason: "Re-evaluated as not a completed transaction under current Financial Event Intelligence rules" },
    },
  });

  return { transactionId: txn.id, correctionId: correction.id };
}

// ---------------------------------------------------------------------------
// Transaction Intelligence Engine (§15): identify EXISTING transactions whose
// ECONOMIC PURPOSE (not lifecycle) would classify differently under the
// account-identity-aware rules this round adds — e.g. a Zable repayment
// that posted as an ordinary Purchase before AccountIdentityResolver
// existed, or a same-user incoming transfer still sitting as plain Income.
// Same safety contract as findSuspiciousLegacyTransactions: read-only,
// bounded scan, never mutates — the caller applies a confirmed correction
// via the EXISTING PATCH /transactions/:id route (transactionType +
// counterpartyAccountId), which already records a RECLASSIFY_EVENT_KIND /
// CONFIRM_COUNTERPARTY_ACCOUNT correction and adjusts the liability balance
// idempotently — no separate "apply" path is duplicated here.
// ---------------------------------------------------------------------------

export interface SuspiciousPurposeCandidate {
  transactionId: string;
  currentTransactionType: string | null;
  amountMinor: string;
  direction: string;
  bookedAt: string;
  merchantName: string | null;
  counterpartyText: string | null;
  suggestedTransactionType: "CREDIT_CARD_REPAYMENT" | "INTERNAL_TRANSFER";
  suggestedAccountId: string;
  suggestedAccountLabel: string;
  reasons: string[];
}

const PURPOSE_SCAN_TAKE = 500; // bounded, mirrors findSuspiciousLegacyTransactions

export async function findSuspiciousEconomicPurpose(userId: string, client: Prisma.TransactionClient = prisma): Promise<SuspiciousPurposeCandidate[]> {
  const txns = await client.transaction.findMany({
    where: {
      userId,
      status: "COMPLETED",
      parentId: null,
      transactionType: { notIn: ["CREDIT_CARD_REPAYMENT", "INTERNAL_TRANSFER", "TRANSFER", "REFUND"] },
      direction: { in: ["INCOME", "EXPENSE"] },
    },
    orderBy: { bookedAt: "desc" },
    take: PURPOSE_SCAN_TAKE,
    select: { id: true, accountId: true, direction: true, amountMinor: true, bookedAt: true, merchantName: true, senderName: true, recipientName: true, transactionType: true },
  });

  const candidates: SuspiciousPurposeCandidate[] = [];
  for (const t of txns) {
    const counterpartyText = (t.direction === "INCOME" ? t.senderName : t.recipientName) ?? t.merchantName ?? null;
    if (!counterpartyText) continue;

    if (t.direction === "EXPENSE") {
      // Real Case 1 pattern: does this payee now resolve to a known owned
      // CREDIT_CARD account?
      const match = await resolveOwnedAccount({ userId, counterpartyText, institutionHint: counterpartyText, desiredAccountType: "CREDIT_CARD", client });
      if (match.accountId && match.confidence === "HIGH" && match.accountId !== t.accountId) {
        candidates.push({
          transactionId: t.id, currentTransactionType: t.transactionType, amountMinor: t.amountMinor.toString(), direction: t.direction,
          bookedAt: t.bookedAt.toISOString(), merchantName: t.merchantName, counterpartyText,
          suggestedTransactionType: "CREDIT_CARD_REPAYMENT", suggestedAccountId: match.accountId, suggestedAccountLabel: counterpartyText,
          reasons: match.reasons,
        });
        continue;
      }
    }
    // Real Case 2 pattern: does the counterparty now resolve to ANY other
    // owned account (person-name or previously-confirmed mapping)?
    const transferMatch = await resolveOwnedAccount({ userId, counterpartyText, client });
    if (transferMatch.accountId && transferMatch.accountId !== t.accountId) {
      candidates.push({
        transactionId: t.id, currentTransactionType: t.transactionType, amountMinor: t.amountMinor.toString(), direction: t.direction,
        bookedAt: t.bookedAt.toISOString(), merchantName: t.merchantName, counterpartyText,
        suggestedTransactionType: "INTERNAL_TRANSFER", suggestedAccountId: transferMatch.accountId, suggestedAccountLabel: counterpartyText,
        reasons: transferMatch.reasons,
      });
    }
  }
  return candidates;
}

/**
 * §15 "DD repayment missing mandate association": a completed
 * CREDIT_CARD_REPAYMENT with no directDebitMandateId, where a mandate for
 * the same company already exists on the same account (e.g. seeded by an
 * earlier pre-alert, or created after this repayment posted) — read-only.
 */
export interface SuspiciousMandateGapCandidate {
  transactionId: string;
  mandateId: string;
  companyName: string;
  amountMinor: string;
  bookedAt: string;
}

export async function findRepaymentsMissingMandate(userId: string, client: Prisma.TransactionClient = prisma): Promise<SuspiciousMandateGapCandidate[]> {
  const txns = await client.transaction.findMany({
    where: { userId, status: "COMPLETED", transactionType: "CREDIT_CARD_REPAYMENT", directDebitMandateId: null },
    orderBy: { bookedAt: "desc" },
    take: PURPOSE_SCAN_TAKE,
    select: { id: true, accountId: true, merchantName: true, amountMinor: true, bookedAt: true },
  });
  if (txns.length === 0) return [];

  const mandates = await client.directDebitMandate.findMany({ where: { userId }, select: { id: true, accountId: true, companyName: true, normalizedCompanyName: true } });
  const candidates: SuspiciousMandateGapCandidate[] = [];
  for (const t of txns) {
    if (!t.merchantName) continue;
    const normalized = normaliseCompany(t.merchantName);
    const mandate = mandates.find((m) => m.accountId === t.accountId && m.normalizedCompanyName === normalized);
    if (mandate) {
      candidates.push({ transactionId: t.id, mandateId: mandate.id, companyName: mandate.companyName, amountMinor: t.amountMinor.toString(), bookedAt: t.bookedAt.toISOString() });
    }
  }
  return candidates;
}
