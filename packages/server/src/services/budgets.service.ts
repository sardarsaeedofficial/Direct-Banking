import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { monthRange, monthPeriodKey, type DateRange } from "./period.service.js";
import { NON_TRANSFER_WHERE } from "./insights.service.js";

// Budget engine (Phase 4 §5–6). Spending that counts toward a budget excludes
// own-account transfers, savings transfers and cancelled/reversed rows — the same
// exclusions insights use — so a budget measures real outgoing spend only.
const BUDGET_SPEND_WHERE: Prisma.TransactionWhereInput = {
  direction: "EXPENSE",
  ...NON_TRANSFER_WHERE,
};

export type BudgetStatus = "ON_TRACK" | "APPROACHING_LIMIT" | "OVER_BUDGET";

export interface BudgetProgress {
  budgetId: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  currency: string;
  limitMinor: number;
  spentMinor: number;
  remainingMinor: number;
  pctBps: number; // spent / limit in basis points (can exceed 10000)
  status: BudgetStatus;
  periodStartIso: string;
  periodEndIso: string;
}

function n(v: bigint | null | undefined): number {
  return v == null ? 0 : Number(v);
}

/** Category ids that count toward a budget: the budget's category plus its children
 *  (so a "Transport" budget also captures "Taxi" spend). Empty for an overall budget. */
async function budgetCategoryIds(userId: string, categoryId: string | null): Promise<string[] | null> {
  if (!categoryId) return null; // overall budget — all spending counts
  const children = await prisma.category.findMany({ where: { userId, parentId: categoryId }, select: { id: true } });
  return [categoryId, ...children.map((c) => c.id)];
}

async function spentForBudget(
  userId: string,
  budget: { categoryId: string | null; currency: string },
  range: DateRange,
): Promise<number> {
  const categoryIds = await budgetCategoryIds(userId, budget.categoryId);
  const agg = await prisma.transaction.aggregate({
    where: {
      userId,
      currency: budget.currency,
      bookedAt: { gte: range.start, lt: range.end },
      ...BUDGET_SPEND_WHERE,
      ...(categoryIds ? { categoryId: { in: categoryIds } } : {}),
    },
    _sum: { amountMinor: true },
  });
  return n(agg._sum.amountMinor);
}

function statusFor(spent: number, limit: number): BudgetStatus {
  if (limit <= 0) return "ON_TRACK";
  if (spent >= limit) return "OVER_BUDGET";
  if (spent >= limit * 0.9) return "APPROACHING_LIMIT";
  return "ON_TRACK";
}

/** Progress for every enabled budget for the current month. */
export async function budgetProgress(userId: string, tz: string, ref: Date = new Date()): Promise<BudgetProgress[]> {
  const budgets = await prisma.budget.findMany({
    where: { userId, enabled: true },
    include: { category: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const range = monthRange(tz, ref);
  const out: BudgetProgress[] = [];
  for (const b of budgets) {
    const limit = n(b.limitMinor);
    const spent = await spentForBudget(userId, b, range);
    out.push({
      budgetId: b.id,
      name: b.name,
      categoryId: b.categoryId,
      categoryName: b.category?.name ?? null,
      currency: b.currency,
      limitMinor: limit,
      spentMinor: spent,
      remainingMinor: limit - spent,
      pctBps: limit > 0 ? Math.round((spent / limit) * 10000) : 0,
      status: statusFor(spent, limit),
      periodStartIso: range.start.toISOString(),
      periodEndIso: range.end.toISOString(),
    });
  }
  return out;
}

export interface BudgetAlert {
  budgetId: string;
  name: string;
  threshold: 50 | 75 | 90 | 100;
  spentMinor: number;
  limitMinor: number;
  currency: string;
}

/**
 * Evaluate budget alert thresholds for the current period and return newly-crossed
 * alerts, de-duplicated: each budget fires at most once per threshold per period. The
 * highest newly-crossed enabled threshold beyond the last one recorded is emitted, and
 * the budget's lastAlertPct/lastAlertPeriodKey are advanced so it never re-fires the
 * same threshold in the same month.
 */
export async function evaluateBudgetAlerts(userId: string, tz: string, ref: Date = new Date()): Promise<BudgetAlert[]> {
  const budgets = await prisma.budget.findMany({ where: { userId, enabled: true } });
  const range = monthRange(tz, ref);
  const periodKey = monthPeriodKey(tz, ref);
  const alerts: BudgetAlert[] = [];

  for (const b of budgets) {
    const limit = n(b.limitMinor);
    if (limit <= 0) continue;
    const spent = await spentForBudget(userId, b, range);
    const pct = (spent / limit) * 100;

    // Enabled thresholds, ascending.
    const enabledThresholds = ([[50, b.alert50], [75, b.alert75], [90, b.alert90], [100, b.alert100]] as const)
      .filter(([, on]) => on).map(([t]) => t as 50 | 75 | 90 | 100);

    // Reset the dedup marker at the start of a new period.
    const lastPct = b.lastAlertPeriodKey === periodKey ? (b.lastAlertPct ?? 0) : 0;
    const crossed = enabledThresholds.filter((t) => pct >= t && t > lastPct);
    if (crossed.length === 0) continue;

    const highest = crossed[crossed.length - 1]!;
    alerts.push({ budgetId: b.id, name: b.name, threshold: highest, spentMinor: spent, limitMinor: limit, currency: b.currency });
    await prisma.budget.update({ where: { id: b.id }, data: { lastAlertPct: highest, lastAlertPeriodKey: periodKey } });
  }
  return alerts;
}
