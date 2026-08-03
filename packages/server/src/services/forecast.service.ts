import { prisma } from "../db.js";
import { addDays } from "@direct-banking/shared";

/** Current manually-entered balances, overall and per active account. */
export async function getBalances(userId: string) {
  const accounts = await prisma.bankAccount.findMany({
    where: { userId, isArchived: false },
    select: { id: true, nickname: true, bankName: true, colour: true, balanceMinor: true, accountType: true, currency: true },
    orderBy: { createdAt: "asc" },
  });
  // Credit cards/loans carry a liability; count them as negative to net worth.
  const totalMinor = accounts.reduce((sum, a) => {
    const sign = a.accountType === "CREDIT_CARD" || a.accountType === "LOAN" ? -1n : 1n;
    return sum + sign * a.balanceMinor;
  }, 0n);
  return { totalMinor, accounts };
}

export interface DailyPoint {
  date: string;
  balanceMinor: number;
  outMinor: number;
}

/**
 * Project the overall daily balance for `days` ahead by applying outstanding
 * expected payments on their due dates. Purely informational — no money moves.
 */
export async function projectDaily(userId: string, days: number, now = new Date()): Promise<DailyPoint[]> {
  const { totalMinor } = await getBalances(userId);
  const end = addDays(now, days);
  const expected = await prisma.expectedPayment.findMany({
    where: { userId, status: { in: ["PROJECTED", "DUE", "OVERDUE"] }, dueDate: { gte: now, lte: end } },
    select: { dueDate: true, expectedAmountMinor: true },
  });

  const byDay = new Map<string, bigint>();
  for (const e of expected) {
    const key = e.dueDate.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0n) + e.expectedAmountMinor);
  }

  const points: DailyPoint[] = [];
  let running = totalMinor;
  for (let i = 0; i <= days; i++) {
    const day = addDays(now, i);
    const key = day.toISOString().slice(0, 10);
    const out = byDay.get(key) ?? 0n;
    running -= out;
    points.push({ date: key, balanceMinor: Number(running), outMinor: Number(out) });
  }
  return points;
}

/** 7/14/30-day forecast summary including the minimum projected balance. */
export async function forecastSummary(userId: string, now = new Date()) {
  const points = await projectDaily(userId, 30, now);
  const horizon = (days: number) => {
    const slice = points.slice(0, days + 1);
    const out = slice.reduce((s, p) => s + p.outMinor, 0);
    const minBalance = Math.min(...slice.map((p) => p.balanceMinor));
    return {
      expectedOutMinor: out,
      projectedBalanceMinor: slice[slice.length - 1]!.balanceMinor,
      minProjectedBalanceMinor: minBalance,
      minRequiredToCoverMinor: Math.max(0, out),
    };
  };
  return { d7: horizon(7), d14: horizon(14), d30: horizon(30), daily: points };
}
