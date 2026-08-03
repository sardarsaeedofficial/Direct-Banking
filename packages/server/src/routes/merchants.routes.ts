import { Router } from "express";
import { prisma } from "../db.js";
import { asyncHandler } from "../middleware/error.js";

export const merchantsRouter = Router();

merchantsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const items = await prisma.merchant.findMany({
      where: { userId: req.auth!.userId },
      include: { _count: { select: { transactions: true } }, defaultCategory: { select: { id: true, name: true } } },
      orderBy: { displayName: "asc" },
    });
    res.json({ items });
  }),
);
