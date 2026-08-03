import { Router } from "express";
import { budgetSchema } from "@direct-banking/shared";
import { startOfMonth, startOfNextMonth, startOfYear } from "@direct-banking/shared";
import { prisma } from "../db.js";
import { requireCsrf } from "../auth/middleware.js";
import { validate, validated } from "../middleware/validate.js";
import { asyncHandler, HttpError } from "../middleware/error.js";

export const budgetsRouter = Router();

async function spentForBudget(userId: string, budget: { categoryId: string | null; period: string }, now = new Date()): Promise<number> {
  const from = budget.period === "YEARLY" ? startOfYear(now) : startOfMonth(now);
  const to = budget.period === "YEARLY" ? new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1)) : startOfNextMonth(now);
  const agg = await prisma.transaction.aggregate({
    _sum: { amountMinor: true },
    where: {
      userId,
      parentId: null,
      direction: "EXPENSE",
      status: { in: ["COMPLETED", "PENDING"] },
      categoryId: budget.categoryId ?? undefined,
      bookedAt: { gte: from, lt: to },
    },
  });
  return Number(agg._sum.amountMinor ?? 0);
}

budgetsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const budgets = await prisma.budget.findMany({
      where: { userId: req.auth!.userId },
      include: { category: { select: { name: true, colour: true } } },
      orderBy: { createdAt: "asc" },
    });
    const items = await Promise.all(
      budgets.map(async (b) => ({
        ...b,
        limitMinor: Number(b.limitMinor),
        spentMinor: await spentForBudget(req.auth!.userId, b),
      })),
    );
    res.json({ items });
  }),
);

budgetsRouter.post(
  "/",
  requireCsrf,
  validate(budgetSchema),
  asyncHandler(async (req, res) => {
    const data = validated<typeof budgetSchema>(res);
    const budget = await prisma.budget.create({
      data: {
        userId: req.auth!.userId,
        name: data.name,
        categoryId: data.categoryId ?? null,
        period: data.period,
        limitMinor: BigInt(data.limitMinor),
        currency: data.currency,
        startDate: new Date(data.startDate),
      },
    });
    res.status(201).json(budget);
  }),
);

budgetsRouter.put(
  "/:id",
  requireCsrf,
  validate(budgetSchema.partial()),
  asyncHandler(async (req, res) => {
    const existing = await prisma.budget.findFirst({ where: { id: req.params.id, userId: req.auth!.userId } });
    if (!existing) throw new HttpError(404, "Budget not found");
    const data = res.locals.body as Record<string, unknown>;
    const budget = await prisma.budget.update({
      where: { id: existing.id },
      data: {
        name: data.name as string | undefined,
        categoryId: (data.categoryId as string | null | undefined) ?? undefined,
        period: data.period as never,
        limitMinor: data.limitMinor !== undefined ? BigInt(data.limitMinor as number) : undefined,
        startDate: data.startDate ? new Date(data.startDate as string) : undefined,
      },
    });
    res.json(budget);
  }),
);

budgetsRouter.delete(
  "/:id",
  requireCsrf,
  asyncHandler(async (req, res) => {
    const existing = await prisma.budget.findFirst({ where: { id: req.params.id, userId: req.auth!.userId } });
    if (!existing) throw new HttpError(404, "Budget not found");
    await prisma.budget.delete({ where: { id: existing.id } });
    res.json({ deleted: true });
  }),
);
