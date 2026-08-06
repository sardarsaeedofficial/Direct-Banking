import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { transactionSchema, transactionQuerySchema, splitSchema } from "@direct-banking/shared";
import { prisma } from "../db.js";
import { requireCsrf } from "../auth/middleware.js";
import { validate, validated } from "../middleware/validate.js";
import { asyncHandler, HttpError } from "../middleware/error.js";
import { audit } from "../services/audit.service.js";
import { createTransaction, reverseTransactionBalance } from "../services/transactions.service.js";

export const transactionsRouter = Router();

transactionsRouter.get(
  "/",
  validate(transactionQuerySchema, "query"),
  asyncHandler(async (req, res) => {
    const q = validated<typeof transactionQuerySchema>(res, "query");
    const where: Prisma.TransactionWhereInput = {
      userId: req.auth!.userId,
      parentId: null, // top-level rows only; split children are nested under their parent
      accountId: q.accountId,
      categoryId: q.categoryId,
      merchantId: q.merchantId,
      direction: q.direction,
      status: q.status,
      ...(q.from || q.to
        ? { bookedAt: { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined } }
        : {}),
      ...(q.search
        ? { OR: [{ description: { contains: q.search, mode: "insensitive" } }, { notes: { contains: q.search, mode: "insensitive" } }] }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        include: { account: { select: { nickname: true, colour: true } }, category: { select: { name: true, colour: true } }, merchant: { select: { displayName: true } }, splits: true },
        orderBy: { bookedAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.transaction.count({ where }),
    ]);

    res.json({ items, total, page: q.page, pageSize: q.pageSize });
  }),
);

transactionsRouter.post(
  "/",
  requireCsrf,
  validate(transactionSchema),
  asyncHandler(async (req, res) => {
    const data = validated<typeof transactionSchema>(res);
    const account = await prisma.bankAccount.findFirst({ where: { id: data.accountId, userId: req.auth!.userId } });
    if (!account) throw new HttpError(404, "Account not found");
    if (data.transferAccountId) {
      const dest = await prisma.bankAccount.findFirst({ where: { id: data.transferAccountId, userId: req.auth!.userId } });
      if (!dest) throw new HttpError(404, "Transfer destination account not found");
    }
    const txn = await createTransaction(req.auth!.userId, {
      ...data,
      bookedAt: new Date(data.bookedAt),
    });
    await audit(req, "transaction.create", { entityType: "Transaction", entityId: txn.id });
    res.status(201).json(txn);
  }),
);

transactionsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const txn = await prisma.transaction.findFirst({
      where: { id: req.params.id, userId: req.auth!.userId },
      include: { account: true, category: true, merchant: true, splits: true, refunds: true, attachments: true },
    });
    if (!txn) throw new HttpError(404, "Transaction not found");
    res.json(txn);
  }),
);

transactionsRouter.put(
  "/:id",
  requireCsrf,
  validate(transactionSchema.partial()),
  asyncHandler(async (req, res) => {
    const existing = await prisma.transaction.findFirst({ where: { id: req.params.id, userId: req.auth!.userId } });
    if (!existing) throw new HttpError(404, "Transaction not found");
    const data = res.locals.body as Record<string, unknown>;
    // Reverse the old balance effect and apply the new one atomically so amount/
    // direction/status edits keep BankAccount.balanceMinor consistent.
    const txn = await prisma.$transaction(async (tx) => {
      await reverseTransactionBalance(tx, existing);
      const updated = await tx.transaction.update({
        where: { id: existing.id },
        data: {
          description: data.description as string | undefined,
          notes: data.notes as string | undefined,
          tags: data.tags as string[] | undefined,
          status: data.status as never,
          direction: data.direction as never,
          categoryId: (data.categoryId as string | null | undefined) ?? undefined,
          amountMinor: data.amountMinor !== undefined ? BigInt(data.amountMinor as number) : undefined,
          bookedAt: data.bookedAt ? new Date(data.bookedAt as string) : undefined,
        },
      });
      // Apply the new effect.
      if (updated.status !== "CANCELLED") {
        const delta = updated.direction === "INCOME" ? updated.amountMinor : -updated.amountMinor;
        await tx.bankAccount.update({ where: { id: updated.accountId }, data: { balanceMinor: { increment: delta } } });
        if (updated.transferAccountId) {
          await tx.bankAccount.update({ where: { id: updated.transferAccountId }, data: { balanceMinor: { increment: -delta } } });
        }
      }
      return updated;
    });
    await audit(req, "transaction.update", { entityType: "Transaction", entityId: txn.id });
    res.json(txn);
  }),
);

transactionsRouter.delete(
  "/:id",
  requireCsrf,
  asyncHandler(async (req, res) => {
    const existing = await prisma.transaction.findFirst({ where: { id: req.params.id, userId: req.auth!.userId } });
    if (!existing) throw new HttpError(404, "Transaction not found");
    await prisma.$transaction(async (tx) => {
      await tx.transaction.deleteMany({ where: { parentId: existing.id } }); // remove split children too
      await reverseTransactionBalance(tx, existing); // keep the balance consistent
      await tx.transaction.delete({ where: { id: existing.id } });
    });
    await audit(req, "transaction.delete", { entityType: "Transaction", entityId: existing.id });
    res.json({ deleted: true });
  }),
);

// Split a transaction into categorised parts (children preserve the original).
transactionsRouter.post(
  "/:id/split",
  requireCsrf,
  validate(splitSchema),
  asyncHandler(async (req, res) => {
    const parent = await prisma.transaction.findFirst({ where: { id: req.params.id, userId: req.auth!.userId } });
    if (!parent) throw new HttpError(404, "Transaction not found");
    const { splits } = validated<typeof splitSchema>(res);
    const sum = splits.reduce((s, p) => s + p.amountMinor, 0);
    if (BigInt(sum) !== parent.amountMinor) throw new HttpError(400, "Split amounts must sum to the original amount");

    await prisma.transaction.deleteMany({ where: { parentId: parent.id } });
    await prisma.$transaction(
      splits.map((p) =>
        prisma.transaction.create({
          data: {
            userId: parent.userId,
            accountId: parent.accountId,
            direction: parent.direction,
            status: parent.status,
            source: parent.source,
            amountMinor: BigInt(p.amountMinor),
            currency: parent.currency,
            bookedAt: parent.bookedAt,
            description: p.description,
            categoryId: p.categoryId ?? undefined,
            parentId: parent.id,
          },
        }),
      ),
    );
    const updated = await prisma.transaction.findUnique({ where: { id: parent.id }, include: { splits: true } });
    await audit(req, "transaction.split", { entityType: "Transaction", entityId: parent.id });
    res.json(updated);
  }),
);

// Record a refund as a NEW income transaction linked to the original.
transactionsRouter.post(
  "/:id/refund",
  requireCsrf,
  asyncHandler(async (req, res) => {
    const original = await prisma.transaction.findFirst({ where: { id: req.params.id, userId: req.auth!.userId } });
    if (!original) throw new HttpError(404, "Transaction not found");
    const amountMinor = Number((req.body?.amountMinor as number | undefined) ?? original.amountMinor);
    const refund = await createTransaction(req.auth!.userId, {
      accountId: original.accountId,
      direction: "INCOME",
      status: "COMPLETED",
      source: original.source,
      amountMinor,
      bookedAt: new Date(),
      description: `Refund: ${original.description}`,
      refundOfId: original.id,
    });
    await prisma.transaction.update({ where: { id: original.id }, data: { status: "REFUNDED" } });
    await audit(req, "transaction.refund", { entityType: "Transaction", entityId: refund.id });
    res.status(201).json(refund);
  }),
);
