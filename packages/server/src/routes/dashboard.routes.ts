import { Router } from "express";
import { asyncHandler } from "../middleware/error.js";
import { getDashboard } from "../services/dashboard.service.js";
import { forecastSummary } from "../services/forecast.service.js";

export const dashboardRouter = Router();

dashboardRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await getDashboard(req.auth!.userId));
  }),
);

dashboardRouter.get(
  "/forecast",
  asyncHandler(async (req, res) => {
    res.json(await forecastSummary(req.auth!.userId));
  }),
);
