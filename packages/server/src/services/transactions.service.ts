import type { Prisma, TxnDirection, TxnStatus, TxnSource } from "@prisma/client";
import { prisma } from "../db.js";
import { linkMerchant } from "./merchant-normalise.service.js";
import { dedupeHash } from "./duplicate-detection.service.js";
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
 *  matching an expected payment when applicable. Never overwrites existing rows. */
export async function createTransaction(userId: string, input: CreateTxnInput) {
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
    categoryId: input.categoryId ?? undefined,
    transferAccountId: input.transferAccountId ?? undefined,
    refundOfId: input.refundOfId ?? undefined,
    expectedPaymentId: expectedPaymentId ?? undefined,
    importBatchId: input.importBatchId ?? undefined,
    dedupeHash: hash,
  };

  // Single source of truth: BankAccount.balanceMinor is the current balance and
  // is adjusted atomically with the transaction so the dashboard total stays
  // consistent (ledger = opening + credits − debits). CANCELLED rows don't move money.
  const status = data.status ?? "COMPLETED";
  return prisma.$transaction(async (tx) => {
    const created = await tx.transaction.create({ data, include: { merchant: true, category: true, account: true } });
    if (status !== "CANCELLED") {
      const delta = input.direction === "INCOME" ? amountMinor : -amountMinor;
      await tx.bankAccount.update({ where: { id: input.accountId }, data: { balanceMinor: { increment: delta } } });
      // A transfer moves value to the counterparty account (net worth unchanged).
      if (input.transferAccountId) {
        await tx.bankAccount.update({ where: { id: input.transferAccountId }, data: { balanceMinor: { increment: -delta } } });
      }
    }
    return created;
  });
}

/**
 * Reverse a transaction's balance effect (used when a transaction is deleted) so
 * the ledger stays consistent. CANCELLED rows had no effect and are skipped.
 */
export async function reverseTransactionBalance(
  tx: Prisma.TransactionClient,
  txn: { accountId: string; direction: string; status: string; amountMinor: bigint; transferAccountId: string | null },
) {
  if (txn.status === "CANCELLED") return;
  const delta = txn.direction === "INCOME" ? txn.amountMinor : -txn.amountMinor;
  await tx.bankAccount.update({ where: { id: txn.accountId }, data: { balanceMinor: { increment: -delta } } });
  if (txn.transferAccountId) {
    await tx.bankAccount.update({ where: { id: txn.transferAccountId }, data: { balanceMinor: { increment: delta } } });
  }
}
