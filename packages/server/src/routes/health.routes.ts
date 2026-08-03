import { Router } from "express";
import { prisma } from "../db.js";
import { asyncHandler } from "../middleware/error.js";

export const healthRouter = Router();

// Liveness + DB connectivity. Kept lightweight for uptime checks.
healthRouter.get(
  "/healthz",
  asyncHandler(async (_req, res) => {
    let db = "up";
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      db = "down";
    }
    res.status(db === "up" ? 200 : 503).json({ status: db === "up" ? "ok" : "degraded", db, time: new Date().toISOString() });
  }),
);
