import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { defaultTypeFor } from "./transactions.service.js";
import { recordCorrection } from "./corrections.service.js";

// Manual internal-transfer pairing (Phase 5) — completes the Phase 1 limitation
// where two sides of an own-account transfer weren't auto-detected. The user
// explicitly links them. Pairing/unpairing only changes CLASSIFICATION; it never
// touches balances (transactionType is not a balance-bearing field).

export class TransferPairError extends Error {}

const SIDE_SELECT = {
  id: true,
  userId: true,
  accountId: true,
  direction: true,
  amountMinor: true,
  currency: true,
  transactionType: true,
  internalTransferGroupId: true,
} satisfies Prisma.TransactionSelect;

/**
 * Pair two of the user's transactions as an internal transfer. Both sides receive the
 * same internalTransferGroupId and transactionType=INTERNAL_TRANSFER, so neither
 * counts as income/spending/budget/merchant spend/savings. Requires two different
 * accounts and opposite directions; balances are never changed.
 */
export async function pairInternalTransfer(userId: string, aId: string, bId: string) {
  if (aId === bId) throw new TransferPairError("Cannot pair a transaction with itself");
  return prisma.$transaction(async (tx) => {
    const rows = await tx.transaction.findMany({ where: { id: { in: [aId, bId] }, userId }, select: SIDE_SELECT });
    if (rows.length !== 2) throw new TransferPairError("Both transactions must exist and belong to you");
    const a = rows.find((r) => r.id === aId)!;
    const b = rows.find((r) => r.id === bId)!;
    if (a.accountId === b.accountId) throw new TransferPairError("Both sides must be on different accounts");
    const opposite = (a.direction === "INCOME" && b.direction === "EXPENSE") || (a.direction === "EXPENSE" && b.direction === "INCOME");
    if (!opposite) throw new TransferPairError("The two sides must be opposite (one in, one out)");
    if (a.internalTransferGroupId || b.internalTransferGroupId) throw new TransferPairError("One side is already paired — unpair it first");

    const groupId = randomUUID();
    for (const side of [a, b]) {
      await tx.transaction.update({
        where: { id: side.id },
        data: { transactionType: "INTERNAL_TRANSFER", internalTransferGroupId: groupId, internalTransferConfidence: "CONFIRMED" },
      });
    }
    await recordCorrection(
      userId,
      {
        transactionId: aId,
        action: "INTERNAL_TRANSFER_PAIR",
        before: { a: { id: a.id, transactionType: a.transactionType }, b: { id: b.id, transactionType: b.transactionType } },
        after: { groupId, transactionType: "INTERNAL_TRANSFER" },
      },
      tx,
    );
    return { groupId, transactionIds: [a.id, b.id] };
  });
}

/**
 * Undo an internal-transfer pairing. Both sides are restored to a normal
 * classification (income stays INCOME, an outgoing becomes a PURCHASE) and lose the
 * group id. Balances are not changed.
 */
export async function unpairInternalTransfer(userId: string, transactionId: string) {
  return prisma.$transaction(async (tx) => {
    const txn = await tx.transaction.findFirst({ where: { id: transactionId, userId }, select: SIDE_SELECT });
    if (!txn) throw new TransferPairError("Transaction not found");
    if (!txn.internalTransferGroupId) throw new TransferPairError("This transaction is not part of a paired transfer");

    const group = await tx.transaction.findMany({
      where: { userId, internalTransferGroupId: txn.internalTransferGroupId },
      select: SIDE_SELECT,
    });
    for (const side of group) {
      await tx.transaction.update({
        where: { id: side.id },
        data: {
          transactionType: defaultTypeFor(side.direction),
          internalTransferGroupId: null,
          internalTransferConfidence: null,
        },
      });
    }
    await recordCorrection(
      userId,
      {
        transactionId,
        action: "INTERNAL_TRANSFER_UNPAIR",
        before: { groupId: txn.internalTransferGroupId, transactionIds: group.map((g) => g.id) },
        after: { unpaired: true },
      },
      tx,
    );
    return { transactionIds: group.map((g) => g.id) };
  });
}
