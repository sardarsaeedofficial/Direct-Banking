import { Router } from "express";
import { expectedStatusSchema } from "@direct-banking/shared";
import { prisma } from "../db.js";
import { requireCsrf } from "../auth/middleware.js";
import { validate, validated } from "../middleware/validate.js";
import { asyncHandler, HttpError } from "../middleware/error.js";
import { generateAllForUser } from "../services/expected-payments.service.js";

export const expectedRouter = Router();

expectedRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const from = req.query.from ? new Date(String(req.query.from)) : new Date();
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now() + 120 * 86_400_000);
    const items = await prisma.expectedPayment.findMany({
      where: { userId: req.auth!.userId, dueDate: { gte: from, lte: to } },
      include: { recurring: { select: { merchantName: true, type: true, isVariable: true } }, account: { select: { nickname: true, colour: true } } },
      orderBy: { dueDate: "asc" },
    });
    res.json({ items });
  }),
);

// Regenerate projections across all active recurring payments.
expectedRouter.post(
  "/generate",
  requireCsrf,
  asyncHandler(async (req, res) => {
    const created = await generateAllForUser(req.auth!.userId);
    res.json({ generated: created });
  }),
);

expectedRouter.patch(
  "/:id",
  requireCsrf,
  validate(expectedStatusSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.expectedPayment.findFirst({ where: { id: req.params.id, userId: req.auth!.userId } });
    if (!existing) throw new HttpError(404, "Expected payment not found");
    const { status } = validated<typeof expectedStatusSchema>(res);
    const updated = await prisma.expectedPayment.update({ where: { id: existing.id }, data: { status } });
    res.json(updated);
  }),
);
