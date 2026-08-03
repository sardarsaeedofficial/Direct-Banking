import { Router } from "express";
import { recurringSchema, recurringUpdateSchema } from "@direct-banking/shared";
import { prisma } from "../db.js";
import { requireCsrf } from "../auth/middleware.js";
import { validate, validated } from "../middleware/validate.js";
import { asyncHandler, HttpError } from "../middleware/error.js";
import { audit } from "../services/audit.service.js";
import { generateExpectedFor } from "../services/expected-payments.service.js";
import { linkMerchant } from "../services/merchant-normalise.service.js";

export const recurringRouter = Router();

recurringRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const items = await prisma.recurringPayment.findMany({
      where: { userId: req.auth!.userId },
      include: { account: { select: { nickname: true, colour: true } }, category: { select: { name: true, colour: true } } },
      orderBy: [{ status: "asc" }, { nextDueDate: "asc" }],
    });
    res.json({ items });
  }),
);

recurringRouter.post(
  "/",
  requireCsrf,
  validate(recurringSchema),
  asyncHandler(async (req, res) => {
    const data = validated<typeof recurringSchema>(res);
    const account = await prisma.bankAccount.findFirst({ where: { id: data.accountId, userId: req.auth!.userId } });
    if (!account) throw new HttpError(404, "Account not found");
    const merchantId = await linkMerchant(req.auth!.userId, data.merchantName);

    const recurring = await prisma.recurringPayment.create({
      data: {
        userId: req.auth!.userId,
        type: data.type,
        merchantId,
        merchantName: data.merchantName,
        accountId: data.accountId,
        expectedAmountMinor: BigInt(data.expectedAmountMinor),
        isVariable: data.isVariable,
        currency: data.currency,
        frequency: data.frequency,
        dayOfMonth: data.dayOfMonth ?? null,
        intervalDays: data.intervalDays ?? null,
        nextDueDate: new Date(data.nextDueDate),
        startDate: new Date(data.startDate),
        endDate: data.endDate ? new Date(data.endDate) : null,
        categoryId: data.categoryId ?? null,
        reminderDays: data.reminderDays,
        status: data.status,
        notes: data.notes,
      },
    });
    const generated = await generateExpectedFor(recurring);
    await audit(req, "recurring.create", { entityType: "RecurringPayment", entityId: recurring.id });
    res.status(201).json({ recurring, generatedExpected: generated });
  }),
);

recurringRouter.put(
  "/:id",
  requireCsrf,
  validate(recurringUpdateSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.recurringPayment.findFirst({ where: { id: req.params.id, userId: req.auth!.userId } });
    if (!existing) throw new HttpError(404, "Recurring payment not found");
    const data = res.locals.body as Record<string, unknown>;
    const updated = await prisma.recurringPayment.update({
      where: { id: existing.id },
      data: {
        type: data.type as never,
        merchantName: data.merchantName as string | undefined,
        accountId: data.accountId as string | undefined,
        expectedAmountMinor: data.expectedAmountMinor !== undefined ? BigInt(data.expectedAmountMinor as number) : undefined,
        isVariable: data.isVariable as boolean | undefined,
        frequency: data.frequency as never,
        dayOfMonth: (data.dayOfMonth as number | null | undefined) ?? undefined,
        intervalDays: (data.intervalDays as number | null | undefined) ?? undefined,
        nextDueDate: data.nextDueDate ? new Date(data.nextDueDate as string) : undefined,
        endDate: data.endDate ? new Date(data.endDate as string) : undefined,
        categoryId: (data.categoryId as string | null | undefined) ?? undefined,
        reminderDays: data.reminderDays as number | undefined,
        status: data.status as never,
        notes: data.notes as string | undefined,
      },
    });
    // Regenerate future projections (idempotent; never overwrites history).
    const generated = await generateExpectedFor(updated);
    await audit(req, "recurring.update", { entityType: "RecurringPayment", entityId: updated.id });
    res.json({ recurring: updated, generatedExpected: generated });
  }),
);

recurringRouter.delete(
  "/:id",
  requireCsrf,
  asyncHandler(async (req, res) => {
    const existing = await prisma.recurringPayment.findFirst({ where: { id: req.params.id, userId: req.auth!.userId } });
    if (!existing) throw new HttpError(404, "Recurring payment not found");
    // Keep matched history; drop only the un-matched future projections.
    await prisma.expectedPayment.deleteMany({ where: { recurringId: existing.id, status: { in: ["PROJECTED", "DUE", "OVERDUE"] } } });
    await prisma.recurringPayment.update({ where: { id: existing.id }, data: { status: "ENDED", endDate: new Date() } });
    await audit(req, "recurring.end", { entityType: "RecurringPayment", entityId: existing.id });
    res.json({ ended: true });
  }),
);
