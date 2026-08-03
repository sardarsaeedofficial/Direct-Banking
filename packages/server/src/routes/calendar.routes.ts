import { Router } from "express";
import { prisma } from "../db.js";
import { asyncHandler } from "../middleware/error.js";
import { projectDaily } from "../services/forecast.service.js";

export const calendarRouter = Router();

// Calendar + timeline data: expected payments in range and a daily balance projection.
calendarRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const now = new Date();
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 0));

    const expected = await prisma.expectedPayment.findMany({
      where: { userId: req.auth!.userId, dueDate: { gte: from, lte: to } },
      include: { recurring: { select: { merchantName: true, type: true } }, account: { select: { nickname: true, colour: true } } },
      orderBy: { dueDate: "asc" },
    });

    const days = Math.min(60, Math.max(7, Math.ceil((to.getTime() - now.getTime()) / 86_400_000)));
    const projection = await projectDaily(req.auth!.userId, days, now);

    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      events: expected.map((e) => ({
        id: e.id,
        date: e.dueDate.toISOString(),
        merchantName: e.recurring.merchantName,
        type: e.recurring.type,
        account: e.account.nickname,
        colour: e.account.colour,
        amountMinor: Number(e.expectedAmountMinor),
        status: e.status,
      })),
      projection,
    });
  }),
);
