import { Router } from "express";
import { reminderSchema } from "@direct-banking/shared";
import { prisma } from "../db.js";
import { requireCsrf } from "../auth/middleware.js";
import { validate, validated } from "../middleware/validate.js";
import { asyncHandler, HttpError } from "../middleware/error.js";

export const remindersRouter = Router();

// In-app reminder feed: already-fired (SENT) reminders form the notification list.
remindersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : undefined;
    const items = await prisma.reminder.findMany({
      where: { userId: req.auth!.userId, status: status as never },
      include: {
        recurring: { select: { merchantName: true } },
        expectedPayment: { select: { dueDate: true, expectedAmountMinor: true } },
      },
      orderBy: { fireAt: "desc" },
      take: 100,
    });
    res.json({ items });
  }),
);

remindersRouter.post(
  "/",
  requireCsrf,
  validate(reminderSchema),
  asyncHandler(async (req, res) => {
    const data = validated<typeof reminderSchema>(res);
    const reminder = await prisma.reminder.create({
      data: {
        userId: req.auth!.userId,
        recurringId: data.recurringId ?? null,
        expectedPaymentId: data.expectedPaymentId ?? null,
        channel: data.channel,
        fireAt: new Date(data.fireAt),
        message: data.message,
      },
    });
    res.status(201).json(reminder);
  }),
);

remindersRouter.patch(
  "/:id/dismiss",
  requireCsrf,
  asyncHandler(async (req, res) => {
    const existing = await prisma.reminder.findFirst({ where: { id: req.params.id, userId: req.auth!.userId } });
    if (!existing) throw new HttpError(404, "Reminder not found");
    const reminder = await prisma.reminder.update({ where: { id: existing.id }, data: { status: "DISMISSED" } });
    res.json(reminder);
  }),
);
