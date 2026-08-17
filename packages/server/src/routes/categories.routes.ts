import { Router } from "express";
import { categorySchema } from "@direct-banking/shared";
import { prisma } from "../db.js";
import { requireCsrf } from "../auth/middleware.js";
import { validate, validated } from "../middleware/validate.js";
import { asyncHandler, HttpError } from "../middleware/error.js";

export const categoriesRouter = Router();

categoriesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const items = await prisma.category.findMany({ where: { userId: req.auth!.userId }, orderBy: { name: "asc" } });
    res.json({ items });
  }),
);

categoriesRouter.post(
  "/",
  requireCsrf,
  validate(categorySchema),
  asyncHandler(async (req, res) => {
    const data = validated<typeof categorySchema>(res);
    const category = await prisma.category.create({
      data: { userId: req.auth!.userId, name: data.name, colour: data.colour, icon: data.icon, parentId: data.parentId ?? null },
    });
    res.status(201).json(category);
  }),
);

categoriesRouter.put(
  "/:id",
  requireCsrf,
  validate(categorySchema.partial()),
  asyncHandler(async (req, res) => {
    const existing = await prisma.category.findFirst({ where: { id: req.params.id, userId: req.auth!.userId } });
    if (!existing) throw new HttpError(404, "Category not found");
    const category = await prisma.category.update({ where: { id: existing.id }, data: res.locals.body });
    res.json(category);
  }),
);

categoriesRouter.delete(
  "/:id",
  requireCsrf,
  asyncHandler(async (req, res) => {
    const existing = await prisma.category.findFirst({ where: { id: req.params.id, userId: req.auth!.userId } });
    if (!existing) throw new HttpError(404, "Category not found");
    // A category referenced by transactions/rules/budgets/merchants/recurring
    // bills/subcategories cannot be deleted without leaving those rows in an
    // inconsistent state — the database's foreign-key constraint would already
    // prevent it, but check first so the client gets a clear, actionable error
    // instead of a raw DB failure (Phase 6 audit: mirrors the same guard
    // accounts.routes.ts already applies). recurringCount was a gap found on
    // re-audit — RecurringPayment.categoryId was not previously checked here.
    const [txnCount, ruleCount, budgetCount, merchantCount, recurringCount, childCount] = await Promise.all([
      prisma.transaction.count({ where: { categoryId: existing.id } }),
      prisma.categoryRule.count({ where: { categoryId: existing.id } }),
      prisma.budget.count({ where: { categoryId: existing.id } }),
      prisma.merchant.count({ where: { defaultCategoryId: existing.id } }),
      prisma.recurringPayment.count({ where: { categoryId: existing.id } }),
      prisma.category.count({ where: { parentId: existing.id } }),
    ]);
    const inUse = txnCount + ruleCount + budgetCount + merchantCount + recurringCount + childCount;
    if (inUse > 0) {
      throw new HttpError(409, "Category is in use and cannot be deleted", {
        transactions: txnCount, rules: ruleCount, budgets: budgetCount, merchants: merchantCount, recurring: recurringCount, subcategories: childCount,
      });
    }
    await prisma.category.delete({ where: { id: existing.id } });
    res.json({ deleted: true });
  }),
);
