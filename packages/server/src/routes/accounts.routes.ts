import { Router } from "express";
import { bankAccountSchema } from "@direct-banking/shared";
import { prisma } from "../db.js";
import { requireCsrf } from "../auth/middleware.js";
import { validate, validated } from "../middleware/validate.js";
import { asyncHandler, HttpError } from "../middleware/error.js";
import { audit } from "../services/audit.service.js";

export const accountsRouter = Router();

accountsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const accounts = await prisma.bankAccount.findMany({
      where: { userId: req.auth!.userId },
      orderBy: [{ isArchived: "asc" }, { createdAt: "asc" }],
    });
    res.json({ items: accounts });
  }),
);

accountsRouter.post(
  "/",
  requireCsrf,
  validate(bankAccountSchema),
  asyncHandler(async (req, res) => {
    const data = validated<typeof bankAccountSchema>(res);
    const account = await prisma.bankAccount.create({
      data: {
        userId: req.auth!.userId,
        bankName: data.bankName,
        nickname: data.nickname,
        accountType: data.accountType,
        lastFour: data.lastFour || null,
        currency: data.currency,
        balanceMinor: BigInt(data.balanceMinor),
        colour: data.colour,
        icon: data.icon,
        isArchived: data.isArchived,
      },
    });
    await audit(req, "account.create", { entityType: "BankAccount", entityId: account.id });
    res.status(201).json(account);
  }),
);

accountsRouter.put(
  "/:id",
  requireCsrf,
  validate(bankAccountSchema.partial()),
  asyncHandler(async (req, res) => {
    const existing = await prisma.bankAccount.findFirst({ where: { id: req.params.id, userId: req.auth!.userId } });
    if (!existing) throw new HttpError(404, "Account not found");
    const data = res.locals.body as Partial<Record<string, unknown>>;
    const account = await prisma.bankAccount.update({
      where: { id: existing.id },
      data: {
        ...data,
        lastFour: data.lastFour === "" ? null : (data.lastFour as string | undefined),
        balanceMinor: data.balanceMinor !== undefined ? BigInt(data.balanceMinor as number) : undefined,
      },
    });
    await audit(req, "account.update", { entityType: "BankAccount", entityId: account.id });
    res.json(account);
  }),
);

accountsRouter.delete(
  "/:id",
  requireCsrf,
  asyncHandler(async (req, res) => {
    const existing = await prisma.bankAccount.findFirst({ where: { id: req.params.id, userId: req.auth!.userId } });
    if (!existing) throw new HttpError(404, "Account not found");
    const txnCount = await prisma.transaction.count({ where: { accountId: existing.id } });
    if (txnCount > 0) {
      // Preserve history: archive rather than delete accounts with transactions.
      const account = await prisma.bankAccount.update({ where: { id: existing.id }, data: { isArchived: true } });
      await audit(req, "account.archive", { entityType: "BankAccount", entityId: account.id });
      res.json({ archived: true, account });
      return;
    }
    await prisma.bankAccount.delete({ where: { id: existing.id } });
    await audit(req, "account.delete", { entityType: "BankAccount", entityId: existing.id });
    res.json({ deleted: true });
  }),
);
