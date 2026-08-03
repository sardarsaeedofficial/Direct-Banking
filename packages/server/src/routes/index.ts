import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { healthRouter } from "./health.routes.js";
import { authRouter } from "./auth.routes.js";
import { accountsRouter } from "./accounts.routes.js";
import { categoriesRouter } from "./categories.routes.js";
import { merchantsRouter } from "./merchants.routes.js";
import { transactionsRouter } from "./transactions.routes.js";
import { recurringRouter } from "./recurring.routes.js";
import { expectedRouter } from "./expected.routes.js";
import { calendarRouter } from "./calendar.routes.js";
import { dashboardRouter } from "./dashboard.routes.js";
import { budgetsRouter } from "./budgets.routes.js";
import { remindersRouter } from "./reminders.routes.js";
import { importsRouter } from "./imports.routes.js";
import { notificationsRouter } from "./notifications.routes.js";
import { reportsRouter } from "./reports.routes.js";
import { settingsRouter } from "./settings.routes.js";

export const apiRouter = Router();

// Public endpoints.
apiRouter.use(healthRouter);
apiRouter.use("/auth", authRouter);

// Everything below requires a valid session.
const protectedRouter = Router();
protectedRouter.use(requireAuth);
protectedRouter.use("/accounts", accountsRouter);
protectedRouter.use("/categories", categoriesRouter);
protectedRouter.use("/merchants", merchantsRouter);
protectedRouter.use("/transactions", transactionsRouter);
protectedRouter.use("/recurring", recurringRouter);
protectedRouter.use("/expected", expectedRouter);
protectedRouter.use("/calendar", calendarRouter);
protectedRouter.use("/dashboard", dashboardRouter);
protectedRouter.use("/budgets", budgetsRouter);
protectedRouter.use("/reminders", remindersRouter);
protectedRouter.use("/imports", importsRouter);
protectedRouter.use("/notifications", notificationsRouter);
protectedRouter.use("/reports", reportsRouter);
protectedRouter.use("/settings", settingsRouter);

apiRouter.use(protectedRouter);
