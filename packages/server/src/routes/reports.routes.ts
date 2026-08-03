import { Router } from "express";
import { asyncHandler, HttpError } from "../middleware/error.js";
import { monthlySummary, yearlySummary, recurringReport, transactionsCsv, groupedToCsv } from "../services/reports.service.js";

export const reportsRouter = Router();

function intParam(value: unknown, fallback: number): number {
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

reportsRouter.get(
  "/monthly",
  asyncHandler(async (req, res) => {
    const now = new Date();
    const year = intParam(req.query.year, now.getUTCFullYear());
    const month = intParam(req.query.month, now.getUTCMonth() + 1);
    if (month < 1 || month > 12) throw new HttpError(400, "month must be 1-12");
    res.json(await monthlySummary(req.auth!.userId, year, month));
  }),
);

reportsRouter.get(
  "/yearly",
  asyncHandler(async (req, res) => {
    const year = intParam(req.query.year, new Date().getUTCFullYear());
    res.json(await yearlySummary(req.auth!.userId, year));
  }),
);

reportsRouter.get(
  "/recurring",
  asyncHandler(async (req, res) => {
    res.json(await recurringReport(req.auth!.userId));
  }),
);

// CSV downloads --------------------------------------------------------------
reportsRouter.get(
  "/transactions.csv",
  asyncHandler(async (req, res) => {
    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;
    const csv = await transactionsCsv(req.auth!.userId, { from, to });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="transactions.csv"');
    res.send(csv);
  }),
);

reportsRouter.get(
  "/monthly.csv",
  asyncHandler(async (req, res) => {
    const now = new Date();
    const year = intParam(req.query.year, now.getUTCFullYear());
    const month = intParam(req.query.month, now.getUTCMonth() + 1);
    const report = await monthlySummary(req.auth!.userId, year, month);
    const csv = groupedToCsv(`Monthly report ${year}-${String(month).padStart(2, "0")} — by category`, report.byCategory);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="monthly-${year}-${String(month).padStart(2, "0")}.csv"`);
    res.send(csv);
  }),
);
