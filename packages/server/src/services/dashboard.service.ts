import { prisma } from "../db.js";
import { startOfMonth, startOfNextMonth } from "@direct-banking/shared";
import { getBalances, forecastSummary } from "./forecast.service.js";
import { detectAnomalies } from "./recurring-detection.service.js";

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Everything the Dashboard renders, computed from real data (no mock values). */
export async function getDashboard(userId: string, now = new Date()) {
  const monthStart = startOfMonth(now);
  const monthEnd = startOfNextMonth(now);
  const twelveMonthsAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  const fiveYearsAgo = new Date(Date.UTC(now.getUTCFullYear() - 4, 0, 1));

  // This-month income & expenditure.
  const monthTxns = await prisma.transaction.findMany({
    where: { userId, parentId: null, status: { in: ["COMPLETED", "PENDING"] }, bookedAt: { gte: monthStart, lt: monthEnd } },
    select: {
      direction: true,
      transactionType: true,
      amountMinor: true,
      accountId: true,
      categoryId: true,
      account: { select: { nickname: true, colour: true } },
      category: { select: { name: true, colour: true } },
    },
  });

  let incomeMinor = 0n;
  let expenseMinor = 0n;
  const byCategory = new Map<string, { name: string; colour: string; amountMinor: number }>();
  const byAccount = new Map<string, { name: string; colour: string; amountMinor: number }>();
  for (const t of monthTxns) {
    // Confirmed internal transfers are movements between the user's own accounts:
    // they are not real income or spending, so they never affect these totals.
    if (t.transactionType === "INTERNAL_TRANSFER") continue;
    if (t.direction === "INCOME") incomeMinor += t.amountMinor;
    else if (t.direction === "EXPENSE") {
      expenseMinor += t.amountMinor;
      const cKey = t.categoryId ?? "uncategorised";
      const c = byCategory.get(cKey) ?? { name: t.category?.name ?? "Uncategorised", colour: t.category?.colour ?? "#94a3b8", amountMinor: 0 };
      c.amountMinor += Number(t.amountMinor);
      byCategory.set(cKey, c);
      const a = byAccount.get(t.accountId) ?? { name: t.account.nickname, colour: t.account.colour, amountMinor: 0 };
      a.amountMinor += Number(t.amountMinor);
      byAccount.set(t.accountId, a);
    }
  }

  // Direct debits this month: expected vs paid.
  const monthExpected = await prisma.expectedPayment.findMany({
    where: { userId, dueDate: { gte: monthStart, lt: monthEnd } },
    include: { recurring: { select: { merchantName: true } } },
  });
  const paidDirectDebitsMinor = monthExpected.filter((e) => e.status === "PAID").reduce((s, e) => s + Number(e.expectedAmountMinor), 0);
  const remainingDirectDebitsMinor = monthExpected
    .filter((e) => e.status !== "PAID" && e.status !== "SKIPPED")
    .reduce((s, e) => s + Number(e.expectedAmountMinor), 0);

  // Upcoming payments (next 10 outstanding).
  const upcoming = await prisma.expectedPayment.findMany({
    where: { userId, status: { in: ["PROJECTED", "DUE", "OVERDUE"] }, dueDate: { gte: monthStart } },
    include: { recurring: { select: { merchantName: true, type: true } }, account: { select: { nickname: true } } },
    orderBy: { dueDate: "asc" },
    take: 10,
  });

  // Balances & forecast.
  const { totalMinor } = await getBalances(userId);
  const forecast = await forecastSummary(userId, now);
  const safeToSpendMinor = Number(totalMinor) - remainingDirectDebitsMinor;
  const expectedEndOfMonthBalanceMinor = Number(totalMinor) - remainingDirectDebitsMinor + 0; // outstanding income excluded (conservative)

  // 12-month and 5-year charts.
  const longTxns = await prisma.transaction.findMany({
    where: { userId, parentId: null, status: { in: ["COMPLETED", "PENDING"] }, bookedAt: { gte: fiveYearsAgo } },
    select: { direction: true, transactionType: true, amountMinor: true, bookedAt: true },
  });
  const monthly = new Map<string, { incomeMinor: number; expenseMinor: number }>();
  const yearly = new Map<number, { incomeMinor: number; expenseMinor: number }>();
  for (const t of longTxns) {
    if (t.transactionType === "INTERNAL_TRANSFER") continue; // exclude own-account transfers
    const amt = Number(t.amountMinor);
    if (t.bookedAt >= twelveMonthsAgo) {
      const k = monthKey(t.bookedAt);
      const m = monthly.get(k) ?? { incomeMinor: 0, expenseMinor: 0 };
      if (t.direction === "INCOME") m.incomeMinor += amt;
      else if (t.direction === "EXPENSE") m.expenseMinor += amt;
      monthly.set(k, m);
    }
    const y = t.bookedAt.getUTCFullYear();
    const yr = yearly.get(y) ?? { incomeMinor: 0, expenseMinor: 0 };
    if (t.direction === "INCOME") yr.incomeMinor += amt;
    else if (t.direction === "EXPENSE") yr.expenseMinor += amt;
    yearly.set(y, yr);
  }

  const monthlyChart: Array<{ month: string; incomeMinor: number; expenseMinor: number }> = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const k = monthKey(d);
    const m = monthly.get(k) ?? { incomeMinor: 0, expenseMinor: 0 };
    monthlyChart.push({ month: k, ...m });
  }
  const yearlyChart = Array.from(yearly.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([year, v]) => ({ year, ...v }));

  // Active recurring subscriptions.
  const subscriptions = await prisma.recurringPayment.findMany({
    where: { userId, status: "ACTIVE" },
    select: { id: true, merchantName: true, type: true, frequency: true, expectedAmountMinor: true, nextDueDate: true, currency: true },
    orderBy: { nextDueDate: "asc" },
  });

  const unusual = await detectAnomalies(userId);

  return {
    period: { start: monthStart.toISOString(), end: monthEnd.toISOString() },
    incomeMinor: Number(incomeMinor),
    expenseMinor: Number(expenseMinor),
    remainingDirectDebitsMinor,
    paidDirectDebitsMinor,
    safeToSpendMinor,
    expectedEndOfMonthBalanceMinor,
    totalBalanceMinor: Number(totalMinor),
    upcoming: upcoming.map((e) => ({
      id: e.id,
      merchantName: e.recurring.merchantName,
      type: e.recurring.type,
      account: e.account.nickname,
      dueDate: e.dueDate.toISOString(),
      amountMinor: Number(e.expectedAmountMinor),
      status: e.status,
    })),
    monthlyChart,
    yearlyChart,
    spendingByCategory: Array.from(byCategory.values()).sort((a, b) => b.amountMinor - a.amountMinor),
    spendingByAccount: Array.from(byAccount.values()).sort((a, b) => b.amountMinor - a.amountMinor),
    subscriptions: subscriptions.map((s) => ({ ...s, expectedAmountMinor: Number(s.expectedAmountMinor), nextDueDate: s.nextDueDate.toISOString() })),
    unusual,
    forecast: { d7: forecast.d7, d14: forecast.d14, d30: forecast.d30 },
  };
}
