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
    await prisma.category.delete({ where: { id: existing.id } });
    res.json({ deleted: true });
  }),
);
