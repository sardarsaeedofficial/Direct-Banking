import { Router } from "express";
import { z } from "zod";
import { notifDecisionSchema } from "@direct-banking/shared";
import { prisma } from "../db.js";
import { requireCsrf } from "../auth/middleware.js";
import { validate, validated } from "../middleware/validate.js";
import { asyncHandler } from "../middleware/error.js";
import { audit } from "../services/audit.service.js";
import { ingestNotification, approveNotification, rejectNotification } from "../services/notification-import.service.js";

export const notificationsRouter = Router();

const ingestBody = z.object({
  sourcePackage: z.string().min(1).max(120),
  title: z.string().min(1).max(240),
  message: z.string().min(1).max(2000),
  receivedAt: z.string().datetime({ offset: true }).optional(),
});

// Review queue.
notificationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : "PENDING";
    const items = await prisma.notificationImport.findMany({
      where: { userId: req.auth!.userId, status: status as never },
      orderBy: { receivedAt: "desc" },
      take: 200,
    });
    res.json({ items });
  }),
);

// Ingest a raw notification (e.g. from a companion phone app) into the queue.
notificationsRouter.post(
  "/ingest",
  requireCsrf,
  validate(ingestBody),
  asyncHandler(async (req, res) => {
    const body = validated<typeof ingestBody>(res);
    const item = await ingestNotification(req.auth!.userId, body);
    res.status(201).json(item);
  }),
);

notificationsRouter.post(
  "/:id/decision",
  requireCsrf,
  validate(notifDecisionSchema),
  asyncHandler(async (req, res) => {
    const decision = validated<typeof notifDecisionSchema>(res);
    if (decision.status === "APPROVED") {
      const txn = await approveNotification(req.auth!.userId, req.params.id, {
        accountId: decision.accountId,
        parsedMerchant: decision.parsedMerchant,
        parsedAmountMinor: decision.parsedAmountMinor,
        categoryId: decision.categoryId,
      });
      await audit(req, "notification.approve", { entityType: "NotificationImport", entityId: req.params.id });
      res.json({ approved: true, transaction: txn });
      return;
    }
    const item = await rejectNotification(req.auth!.userId, req.params.id);
    await audit(req, "notification.reject", { entityType: "NotificationImport", entityId: req.params.id });
    res.json({ rejected: true, item });
  }),
);
