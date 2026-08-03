import { Router } from "express";
import { z } from "zod";
import { settingSchema } from "@direct-banking/shared";
import { prisma } from "../db.js";
import { requireCsrf } from "../auth/middleware.js";
import { validate, validated } from "../middleware/validate.js";
import { asyncHandler } from "../middleware/error.js";

export const settingsRouter = Router();

const profileSchema = z.object({
  displayName: z.string().max(120).optional(),
  baseCurrency: z.string().length(3).optional(),
  locale: z.string().max(10).optional(),
});

settingsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const settings = await prisma.appSetting.findMany({ where: { userId: req.auth!.userId } });
    res.json({ items: settings });
  }),
);

settingsRouter.put(
  "/",
  requireCsrf,
  validate(settingSchema),
  asyncHandler(async (req, res) => {
    const { key, value } = validated<typeof settingSchema>(res);
    const setting = await prisma.appSetting.upsert({
      where: { userId_key: { userId: req.auth!.userId, key } },
      create: { userId: req.auth!.userId, key, value: value as never },
      update: { value: value as never },
    });
    res.json(setting);
  }),
);

settingsRouter.put(
  "/profile",
  requireCsrf,
  validate(profileSchema),
  asyncHandler(async (req, res) => {
    const data = validated<typeof profileSchema>(res);
    const user = await prisma.user.update({
      where: { id: req.auth!.userId },
      data,
      select: { id: true, email: true, displayName: true, baseCurrency: true, locale: true },
    });
    res.json({ user });
  }),
);
