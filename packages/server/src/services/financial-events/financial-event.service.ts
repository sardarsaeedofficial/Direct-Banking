import type { Prisma, FinancialEvent, TxnDirection } from "@prisma/client";
import { prisma } from "../../db.js";
import { classifyNotification, type ClientDirection } from "./classifier.js";
import { decidePosting, canTransition } from "./ledger-posting-policy.js";
import { createTransaction } from "../transactions.service.js";
import { detectAndPairInternalTransfer } from "../internal-transfer.service.js";
import { detectDirectDebit, normaliseCompany } from "../direct-debit.service.js";

// ---------------------------------------------------------------------------
// Financial Event orchestration — the semantic layer between notification
// capture and canonical ledger posting:
//
//   Notification -> Source Trust Check -> Bank-specific Parser ->
//   Financial Event Classifier -> Lifecycle/Semantic Validation ->
//   Financial Event -> Ledger Posting Policy -> Reconciliation ->
//   Canonical Transaction
//
// This module is steps 4 onward (the caller supplies the source-trust result
// and raw notification text; classifyNotification.ts is step 4;
// ledger-posting-policy.ts is step 8). Only ingestFinancialEvent() may ever
// call createTransaction() from a notification — no route handler does so
// directly any more (see mobile.routes.ts's /notification-imports/auto).
// ---------------------------------------------------------------------------

export interface IngestFinancialEventInput {
  accountId: string;
  sourcePackage: string;
  sourceType?: string;
  sourceFingerprint: string;
  trustedSource: boolean;
  title: string;
  redactedText: string;
  merchantHint?: string | null;
  clientDirection?: ClientDirection | null;
  clientAmountMinor?: number | null;
  clientConfidence?: number | null;
  occurredAt: Date;
  notificationImportId?: string | null;
  categoryId?: string | null;
  senderName?: string | null;
  senderBankName?: string | null;
  recipientName?: string | null;
  recipientBankName?: string | null;
  paymentReference?: string | null;
  paymentReason?: string | null;
}

export interface IngestFinancialEventResult {
  event: FinancialEvent;
  transaction: Prisma.TransactionGetPayload<{ include: { merchant: true; category: true; account: true } }> | null;
  duplicate: boolean;
  canPost: boolean;
  ledgerImpact: string;
  requiresReview: boolean;
}

/** Find an existing PENDING event for the same account/amount/merchant, close
 *  in time, that a new notification's classification should be understood as
 *  updating rather than a brand-new payment attempt (§22–25). Deliberately
 *  conservative: a prior event that already reached a terminal lifecycle
 *  never matches, so a decline followed by a genuinely new successful retry
 *  correctly creates its own separate event instead of overwriting the
 *  decline (§25). */
async function findMatchingPendingEvent(
  userId: string,
  candidate: { accountId: string; amountMinor: number | null; merchantName: string | null; occurredAt: Date },
  client: Prisma.TransactionClient,
): Promise<FinancialEvent | null> {
  if (candidate.amountMinor == null) return null;
  const windowMs = 4 * 60 * 60 * 1000; // 4 hours — generous enough for a slow pending->settle cycle, tight enough not to accidentally match an unrelated later purchase
  const rows = await client.financialEvent.findMany({
    where: {
      userId,
      accountId: candidate.accountId,
      lifecycle: "PENDING",
      amountMinor: candidate.amountMinor,
      occurredAt: { gte: new Date(candidate.occurredAt.getTime() - windowMs), lte: new Date(candidate.occurredAt.getTime() + windowMs) },
    },
    orderBy: { occurredAt: "desc" },
    take: 5,
  });
  if (rows.length === 0) return null;
  if (!candidate.merchantName) return rows[0]!;
  const norm = candidate.merchantName.trim().toLowerCase();
  return rows.find((r) => (r.merchantName ?? "").trim().toLowerCase() === norm) ?? rows[0]!;
}

/**
 * Seed/update a Direct-Debit-like mandate (DIRECT_DEBIT or
 * CREDIT_CARD_REPAYMENT) from an UPCOMING pre-alert, before any real payment
 * has ever been linked. Reuses the exact same mandate identity
 * (userId+accountId+normalizedCompanyName) the real Direct Debit engine uses,
 * so when the actual payment later arrives, detectDirectDebit() finds and
 * reconciles with THIS SAME mandate rather than creating a duplicate one —
 * "one mandate per company", never "one mandate per notification wording".
 * Never creates a transaction and never moves money.
 */
export async function recordUpcomingDirectDebitLike(
  userId: string,
  ctx: { accountId: string; merchantName: string | null; amountMinor: number; expectedAt: Date | null; kind: "DIRECT_DEBIT" | "CREDIT_CARD_REPAYMENT" },
  client: Prisma.TransactionClient = prisma,
): Promise<string | null> {
  const company = (ctx.merchantName ?? "").trim();
  const normalized = normaliseCompany(company);
  if (!normalized) return null;

  const existing = await client.directDebitMandate.findUnique({
    where: { userId_accountId_normalizedCompanyName: { userId, accountId: ctx.accountId, normalizedCompanyName: normalized } },
    select: { id: true },
  });

  const mandateId = existing
    ? existing.id
    : (
        await client.directDebitMandate.create({
          data: {
            userId,
            accountId: ctx.accountId,
            companyName: company || normalized,
            normalizedCompanyName: normalized,
            // RecurringKind has no repayment-specific value — the mandate's
            // kind stays DIRECT_DEBIT (the payment rail); the economic
            // distinction (ordinary DD vs credit-card repayment) lives on
            // FinancialEvent.eventKind / Transaction.transactionType instead.
            kind: "DIRECT_DEBIT",
            status: "ACTIVE",
            firstSeenAt: ctx.expectedAt ?? new Date(),
          },
          select: { id: true },
        })
      ).id;

  // Seed/update the SYSTEM-predicted expectation only — never the user's
  // explicit override fields — exactly the fields recomputeMandate() itself
  // writes, so a later real payment's recompute naturally supersedes this
  // pre-alert estimate with a learned one, without any special-casing.
  await client.directDebitMandate.update({
    where: { id: mandateId },
    data: {
      expectedAmountMinor: ctx.amountMinor,
      nextExpectedAt: ctx.expectedAt ?? undefined,
    },
  });

  return mandateId;
}

/**
 * Best-effort liability link for a completed credit-card repayment: if the
 * user also tracks the receiving credit-card account (matched by normalised
 * name — the same matching function the Direct Debit engine uses, no fuzzy
 * guessing), its balance ("amount owed") decreases by the repayment amount,
 * exactly like the cash account's balance decreases. This is a direct balance
 * adjustment, not a second ledger Transaction — mirroring how
 * setProviderBalance() adjusts a balance directly for Open Banking — so it
 * never gets swept up in internal-transfer pairing/unpairing logic that
 * expects two real transaction rows. A PROVIDER-authoritative credit-card
 * account is never touched here (Phase 6 protection preserved).
 */
export async function linkCreditCardRepayment(
  userId: string,
  ctx: { amountMinor: number; merchantName: string | null },
  client: Prisma.TransactionClient = prisma,
): Promise<string | null> {
  if (!ctx.merchantName) return null;
  const normalized = normaliseCompany(ctx.merchantName);
  if (!normalized) return null;
  const candidates = await client.bankAccount.findMany({
    where: { userId, accountType: "CREDIT_CARD", isArchived: false, balanceAuthority: { not: "PROVIDER" } },
    select: { id: true, nickname: true, bankName: true },
  });
  const match = candidates.find((a) => normaliseCompany(a.nickname) === normalized || normaliseCompany(a.bankName) === normalized);
  if (!match) return null;
  await client.bankAccount.update({ where: { id: match.id }, data: { balanceMinor: { decrement: BigInt(ctx.amountMinor) } } });
  return match.id;
}

/** Reconcile a REFUNDED/REVERSED financial event against the most recent
 *  matching completed expense: creates the standard offsetting income
 *  correction (reusing the exact pattern the existing manual /refund route
 *  already uses — refundOfId link, original marked REFUNDED), so audit
 *  history is retained and the balance is corrected exactly once. */
async function reconcileRefundOrReversal(
  userId: string,
  ctx: { accountId: string; amountMinor: number; merchantName: string | null; occurredAt: Date },
  client: Prisma.TransactionClient,
) {
  const norm = ctx.merchantName ? ctx.merchantName.trim().toLowerCase() : null;
  const candidates = await client.transaction.findMany({
    where: {
      userId,
      accountId: ctx.accountId,
      direction: "EXPENSE",
      status: "COMPLETED",
      amountMinor: BigInt(ctx.amountMinor),
      refundOfId: null,
      bookedAt: { gte: new Date(ctx.occurredAt.getTime() - 180 * 86_400_000) },
    },
    orderBy: { bookedAt: "desc" },
    take: 10,
  });
  const original = norm
    ? candidates.find((c) => (c.merchantName ?? c.description ?? "").toLowerCase().includes(norm) || norm.includes((c.merchantName ?? "").toLowerCase())) ?? candidates[0]
    : candidates[0];
  if (!original) return null;

  const correction = await createTransaction(
    userId,
    {
      accountId: ctx.accountId,
      direction: "INCOME",
      status: "COMPLETED",
      source: "NOTIFICATION",
      amountMinor: ctx.amountMinor,
      bookedAt: ctx.occurredAt,
      description: `Refund: ${original.description}`,
      merchantName: original.merchantName,
      refundOfId: original.id,
      transactionType: "REFUND",
      autoCategorize: false,
      categoryId: original.categoryId,
    },
    client,
  );
  await client.transaction.update({ where: { id: original.id }, data: { status: "REFUNDED" } });
  return correction;
}

/**
 * The single entry point that turns a raw (already source-trust-checked)
 * notification into a FinancialEvent and — only when the posting policy
 * allows it — a canonical Transaction. Idempotent by sourceFingerprint.
 */
export async function ingestFinancialEvent(
  userId: string,
  input: IngestFinancialEventInput,
  client: Prisma.TransactionClient = prisma,
): Promise<IngestFinancialEventResult> {
  const existing = await client.financialEvent.findUnique({
    where: { userId_sourceFingerprint: { userId, sourceFingerprint: input.sourceFingerprint } },
  });
  if (existing) {
    const txn = existing.linkedTransactionId
      ? await client.transaction.findUnique({ where: { id: existing.linkedTransactionId }, include: { merchant: true, category: true, account: true } })
      : null;
    const posting = decidePosting(existing);
    return { event: existing, transaction: txn, duplicate: true, canPost: posting.canPost, ledgerImpact: existing.ledgerImpact, requiresReview: posting.requiresReview };
  }

  const classified = classifyNotification({
    sourcePackage: input.sourcePackage,
    trustedSource: input.trustedSource,
    title: input.title,
    text: input.redactedText,
    merchantHint: input.merchantHint,
    clientDirection: input.clientDirection ?? undefined,
    clientAmountMinor: input.clientAmountMinor ?? undefined,
    clientConfidence: input.clientConfidence ?? undefined,
    occurredAt: input.occurredAt,
  });

  if (!classified.isFinancial) {
    const created = await client.financialEvent.create({
      data: {
        userId,
        accountId: input.accountId,
        sourceType: input.sourceType ?? "NOTIFICATION",
        sourcePackage: input.sourcePackage,
        sourceFingerprint: input.sourceFingerprint,
        eventKind: "NON_FINANCIAL",
        lifecycle: "UNKNOWN",
        moneyEffect: "NONE",
        ledgerImpact: "NONE",
        merchantName: classified.merchantName ?? undefined,
        occurredAt: input.occurredAt,
        confidenceScore: classified.confidenceScore,
        confidenceLevel: classified.confidenceLevel,
        reasonCode: classified.reasonCode,
        notificationImportId: input.notificationImportId ?? undefined,
      },
    });
    return { event: created, transaction: null, duplicate: false, canPost: false, ledgerImpact: "NONE", requiresReview: false };
  }

  const posting = decidePosting({ lifecycle: classified.lifecycle, confidenceLevel: classified.confidenceLevel });

  let matched: FinancialEvent | null = null;
  if (classified.lifecycle === "COMPLETED" || classified.lifecycle === "DECLINED" || classified.lifecycle === "FAILED" || classified.lifecycle === "REVERSED") {
    matched = await findMatchingPendingEvent(userId, { accountId: input.accountId, amountMinor: classified.amountMinor, merchantName: classified.merchantName, occurredAt: input.occurredAt }, client);
  }

  let eventRow: FinancialEvent;
  if (matched && canTransition(matched.lifecycle, classified.lifecycle)) {
    eventRow = await client.financialEvent.update({
      where: { id: matched.id },
      data: {
        lifecycle: classified.lifecycle,
        moneyEffect: classified.moneyEffect,
        ledgerImpact: posting.ledgerImpact,
        settledAt: classified.lifecycle === "COMPLETED" ? input.occurredAt : undefined,
        confidenceScore: classified.confidenceScore,
        confidenceLevel: classified.confidenceLevel,
        reasonCode: classified.reasonCode,
        notificationImportId: input.notificationImportId ?? matched.notificationImportId ?? undefined,
      },
    });
  } else {
    eventRow = await client.financialEvent.create({
      data: {
        userId,
        accountId: input.accountId,
        sourceType: input.sourceType ?? "NOTIFICATION",
        sourcePackage: input.sourcePackage,
        sourceFingerprint: input.sourceFingerprint,
        eventKind: classified.eventKind,
        lifecycle: classified.lifecycle,
        paymentRail: classified.paymentRail ?? undefined,
        amountMinor: classified.amountMinor ?? undefined,
        currency: "GBP",
        expectedDirection: classified.expectedDirection ?? undefined,
        moneyEffect: classified.moneyEffect,
        ledgerImpact: posting.ledgerImpact,
        expectedAt: classified.expectedAt ?? undefined,
        occurredAt: input.occurredAt,
        merchantName: classified.merchantName ?? undefined,
        senderName: input.senderName ?? undefined,
        recipientName: input.recipientName ?? undefined,
        reference: input.paymentReference ?? undefined,
        confidenceScore: classified.confidenceScore,
        confidenceLevel: classified.confidenceLevel,
        reasonCode: classified.reasonCode,
        notificationImportId: input.notificationImportId ?? undefined,
      },
    });
  }

  let transaction: Prisma.TransactionGetPayload<{ include: { merchant: true; category: true; account: true } }> | null = null;

  // UPCOMING Direct Debit / credit-card repayment pre-alert: seed/update the
  // mandate, never post a transaction.
  if (classified.lifecycle === "UPCOMING" && (classified.eventKind === "DIRECT_DEBIT" || classified.eventKind === "CREDIT_CARD_REPAYMENT") && classified.amountMinor) {
    const mandateId = await recordUpcomingDirectDebitLike(
      userId,
      { accountId: input.accountId, merchantName: classified.merchantName, amountMinor: classified.amountMinor, expectedAt: classified.expectedAt, kind: classified.eventKind },
      client,
    );
    if (mandateId) eventRow = await client.financialEvent.update({ where: { id: eventRow.id }, data: { directDebitMandateId: mandateId } });
  }

  if (posting.canPost && posting.ledgerImpact === "POSTED" && classified.amountMinor && classified.expectedDirection) {
    transaction = await createTransaction(
      userId,
      {
        accountId: input.accountId,
        direction: classified.expectedDirection as TxnDirection,
        status: "COMPLETED",
        source: "NOTIFICATION",
        amountMinor: classified.amountMinor,
        currency: "GBP",
        bookedAt: input.occurredAt,
        description: classified.merchantName ?? input.title,
        merchantName: classified.merchantName ?? input.title,
        categoryId: input.categoryId ?? undefined,
        transactionType: classified.eventKind === "CREDIT_CARD_REPAYMENT" ? "CREDIT_CARD_REPAYMENT" : undefined,
        senderName: input.senderName ?? undefined,
        senderBankName: input.senderBankName ?? undefined,
        recipientName: input.recipientName ?? undefined,
        recipientBankName: input.recipientBankName ?? undefined,
        paymentReference: input.paymentReference ?? undefined,
        paymentReason: input.paymentReason ?? undefined,
        sourceBankPackage: input.sourcePackage,
      },
      client,
    );

    if (classified.eventKind === "CREDIT_CARD_REPAYMENT") {
      await linkCreditCardRepayment(userId, { amountMinor: classified.amountMinor, merchantName: classified.merchantName }, client);
    } else {
      const transferConfidence = await detectAndPairInternalTransfer(userId, transaction.id, client);
      if (transferConfidence !== "CONFIRMED" && transferConfidence !== "HIGH") {
        await detectDirectDebit(
          userId,
          transaction.id,
          {
            merchant: classified.merchantName,
            text: input.redactedText,
            amountMinor: classified.amountMinor,
            accountId: input.accountId,
            bookedAt: input.occurredAt,
            direction: classified.expectedDirection,
            reference: input.paymentReference,
          },
          client,
        );
      }
    }

    eventRow = await client.financialEvent.update({ where: { id: eventRow.id }, data: { linkedTransactionId: transaction.id, settledAt: input.occurredAt } });
  } else if ((classified.lifecycle === "REFUNDED" || classified.lifecycle === "REVERSED") && classified.amountMinor) {
    const correction = await reconcileRefundOrReversal(userId, { accountId: input.accountId, amountMinor: classified.amountMinor, merchantName: classified.merchantName, occurredAt: input.occurredAt }, client);
    if (correction) {
      transaction = correction;
      eventRow = await client.financialEvent.update({ where: { id: eventRow.id }, data: { linkedTransactionId: correction.id, ledgerImpact: "CORRECTED" } });
    }
  }

  return {
    event: eventRow,
    transaction,
    duplicate: false,
    canPost: posting.canPost,
    ledgerImpact: eventRow.ledgerImpact,
    requiresReview: posting.requiresReview,
  };
}
