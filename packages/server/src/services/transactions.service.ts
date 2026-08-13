import type { Prisma, TxnDirection, TxnStatus, TxnSource, TxnType } from "@prisma/client";
import { prisma } from "../db.js";
import { linkMerchant } from "./merchant-normalise.service.js";
import { dedupeHash } from "./duplicate-detection.service.js";
import { categorizeTransaction } from "./categorization.service.js";
import { addDays, absMinor } from "@direct-banking/shared";

export interface CreateTxnInput {
  accountId: string;
  direction: TxnDirection;
  status?: TxnStatus;
  source?: TxnSource;
  amountMinor: number;
  currency?: string;
  bookedAt: Date;
  description: string;
  notes?: string | null;
  tags?: string[];
  merchantName?: string | null;
  categoryId?: string | null;
  transferAccountId?: string | null;
  refundOfId?: string | null;
  importBatchId?: string | null;
  // ---- Phase 1: rich ledger fields (all optional) ----
  transactionType?: TxnType | null;
  senderName?: string | null;
  senderBankName?: string | null;
  recipientName?: string | null;
  recipientBankName?: string | null;
  paymentReference?: string | null;
  paymentReason?: string | null;
  sourceBankPackage?: string | null;
  occurredAt?: Date | null;
  settledAt?: Date | null;
  // ---- Phase 3 ----
  // When false, the transaction is recorded WITHOUT moving BankAccount.balanceMinor
  // (balanceApplied=false). Used for provider-authoritative (Open Banking) accounts
  // whose balance comes from the bank, so historical imports never double-count.
  applyBalance?: boolean;
  // ---- Phase 4: automatic categorisation ----
  // A trusted provider-supplied category string (Open Banking), used as one input to
  // the categorisation chain. Never trusted blindly — only clean mappings are applied.
  providerCategory?: string | null;
  // When true (default) and no explicit categoryId is supplied, run the categorisation
  // engine. An explicit categoryId always wins (user-explicit) and disables auto-categorise.
  autoCategorize?: boolean;
}

/** Canonical ledger type implied by a coarse direction when none is supplied. */
export function defaultTypeFor(direction: TxnDirection): TxnType {
  if (direction === "INCOME") return "INCOME";
  if (direction === "TRANSFER") return "TRANSFER";
  return "PURCHASE";
}

/**
 * Try to match an expense to an outstanding expected payment on the same
 * account (amount within 10% for variable, within tolerance otherwise, due
 * within a week). On match, the expected payment is marked PAID and linked —
 * the historical transaction is preserved either way.
 */
async function matchExpectedPayment(
  userId: string,
  accountId: string,
  amountMinor: bigint,
  bookedAt: Date,
): Promise<string | null> {
  const candidates = await prisma.expectedPayment.findMany({
    where: {
      userId,
      accountId,
      status: { in: ["PROJECTED", "DUE", "OVERDUE"] },
      dueDate: { gte: addDays(bookedAt, -10), lte: addDays(bookedAt, 10) },
    },
    include: { recurring: true },
    orderBy: { dueDate: "asc" },
  });

  for (const c of candidates) {
    const expected = c.expectedAmountMinor;
    const tolerance = c.recurring.isVariable ? expected / 5n : expected / 20n; // 20% or 5%
    if (absMinor(amountMinor - expected) <= tolerance) {
      await prisma.expectedPayment.update({ where: { id: c.id }, data: { status: "PAID" } });
      return c.id;
    }
  }
  return null;
}

/** Create a transaction, linking merchant, computing the dedupe hash, and
 *  matching an expected payment when applicable. Never overwrites existing rows.
 *  Pass an existing transaction client to run the create + balance update inside
 *  a caller's `$transaction` (used by the atomic auto-import operation). */
export async function createTransaction(userId: string, input: CreateTxnInput, client?: Prisma.TransactionClient) {
  const amountMinor = BigInt(input.amountMinor);
  const merchantId = await linkMerchant(userId, input.merchantName ?? input.description);
  const hash = dedupeHash({
    accountId: input.accountId,
    bookedAt: input.bookedAt,
    amountMinor,
    direction: input.direction,
    description: input.description,
  });

  let expectedPaymentId: string | null = null;
  if (input.direction === "EXPENSE" && (input.status ?? "COMPLETED") !== "CANCELLED") {
    expectedPaymentId = await matchExpectedPayment(userId, input.accountId, amountMinor, input.bookedAt);
  }

  // Categorisation: an explicit categoryId is treated as user-explicit and wins.
  // Otherwise run the priority chain (rule → learned merchant → provider → heuristic).
  let categoryId: string | null = input.categoryId ?? null;
  let subcategoryText: string | null = null;
  if (!categoryId && (input.autoCategorize ?? true)) {
    const result = await categorizeTransaction(
      userId,
      {
        merchantName: input.merchantName,
        description: input.description,
        recipientName: input.recipientName,
        senderName: input.senderName,
        providerCategory: input.providerCategory ?? null,
        direction: input.direction as "INCOME" | "EXPENSE" | "TRANSFER",
        transactionType: input.transactionType ?? null,
        merchantId,
      },
      client ?? prisma,
    );
    categoryId = result.categoryId;
    subcategoryText = result.subcategoryName;
  }

  const data: Prisma.TransactionUncheckedCreateInput = {
    userId,
    accountId: input.accountId,
    direction: input.direction,
    status: input.status ?? "COMPLETED",
    source: input.source ?? "MANUAL",
    amountMinor,
    currency: input.currency ?? "GBP",
    bookedAt: input.bookedAt,
    description: input.description,
    notes: input.notes ?? undefined,
    tags: input.tags ?? [],
    merchantId: merchantId ?? undefined,
    categoryId: categoryId ?? undefined,
    subcategory: subcategoryText ?? undefined,
    transferAccountId: input.transferAccountId ?? undefined,
    refundOfId: input.refundOfId ?? undefined,
    expectedPaymentId: expectedPaymentId ?? undefined,
    importBatchId: input.importBatchId ?? undefined,
    dedupeHash: hash,
    // Newly-created transactions maintain the balance unless cancelled or the
    // caller opted out (provider-authoritative accounts).
    balanceApplied: (input.applyBalance ?? true) && (input.status ?? "COMPLETED") !== "CANCELLED",
    settledAt: input.settledAt ?? undefined,
    // ---- Phase 1 rich ledger fields ----
    transactionType: input.transactionType ?? defaultTypeFor(input.direction),
    merchantName: input.merchantName ?? undefined,
    senderName: input.senderName ?? undefined,
    senderBankName: input.senderBankName ?? undefined,
    recipientName: input.recipientName ?? undefined,
    recipientBankName: input.recipientBankName ?? undefined,
    paymentReference: input.paymentReference ?? undefined,
    paymentReason: input.paymentReason ?? undefined,
    sourceBankPackage: input.sourceBankPackage ?? undefined,
    occurredAt: input.occurredAt ?? undefined,
  };

  // Single source of truth: BankAccount.balanceMinor is the current balance and
  // is adjusted atomically with the transaction so the dashboard total stays
  // consistent (ledger = opening + credits − debits). CANCELLED rows don't move money.
  const status = data.status ?? "COMPLETED";
  const applyBalance = (input.applyBalance ?? true) && status !== "CANCELLED";
  const run = async (tx: Prisma.TransactionClient) => {
    const created = await tx.transaction.create({ data, include: { merchant: true, category: true, account: true } });
    if (applyBalance) {
      const delta = input.direction === "INCOME" ? amountMinor : -amountMinor;
      await tx.bankAccount.update({ where: { id: input.accountId }, data: { balanceMinor: { increment: delta } } });
      // A transfer moves value to the counterparty account (net worth unchanged).
      if (input.transferAccountId) {
        await tx.bankAccount.update({ where: { id: input.transferAccountId }, data: { balanceMinor: { increment: -delta } } });
      }
    }
    return created;
  };
  return client ? run(client) : prisma.$transaction(run);
}

/**
 * Set a provider-authoritative balance (Phase 3). For PROVIDER accounts the bank's
 * reported balance is the truth — this overwrites balanceMinor directly instead of
 * summing transactions, so importing history never double-counts.
 */
export async function setProviderBalance(
  client: Prisma.TransactionClient,
  accountId: string,
  currentMinor: number,
  availableMinor?: number | null,
): Promise<void> {
  await client.bankAccount.update({
    where: { id: accountId },
    data: {
      balanceMinor: BigInt(currentMinor),
      availableBalanceMinor: availableMinor != null ? BigInt(availableMinor) : undefined,
    },
  });
}

/**
 * Reverse a transaction's balance effect (used when a transaction is edited or
 * deleted). Only rows whose effect was actually applied (balanceApplied = true)
 * are reversed, so legacy transactions created before balance maintenance never
 * change account balances.
 */
export async function reverseTransactionBalance(
  tx: Prisma.TransactionClient,
  txn: { accountId: string; direction: string; amountMinor: bigint; transferAccountId: string | null; balanceApplied: boolean },
) {
  if (!txn.balanceApplied) return;
  const delta = txn.direction === "INCOME" ? txn.amountMinor : -txn.amountMinor;
  await tx.bankAccount.update({ where: { id: txn.accountId }, data: { balanceMinor: { increment: -delta } } });
  if (txn.transferAccountId) {
    await tx.bankAccount.update({ where: { id: txn.transferAccountId }, data: { balanceMinor: { increment: delta } } });
  }
}
