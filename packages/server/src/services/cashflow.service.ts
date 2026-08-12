import { prisma } from "../db.js";
import { monthRange } from "./period.service.js";
import { getUpcomingPayments } from "./direct-debit.service.js";
import { primaryCurrencyFor, NON_TRANSFER_WHERE } from "./insights.service.js";

// Cash-flow forecasting, safe-to-spend & upcoming commitments (Phase 4 §15–17).
// Everything here is an ESTIMATE: it projects from expected/recurring commitments and
// detected recurring income, and is always surfaced as a forecast, never a guarantee.
// Internal (own-account) transfers are net-zero and are excluded from every figure.

const DAY = 86_400_000;
const ASSET_TYPES = new Set(["CURRENT", "SAVINGS", "CASH"]);

function n(v: bigint | null | undefined): number {
  return v == null ? 0 : Number(v);
}

export type UpcomingSource = "DIRECT_DEBIT" | "SUBSCRIPTION" | "RECURRING_CARD" | "STANDING_ORDER" | "EXPECTED_PAYMENT";

export interface UpcomingPayment {
  id: string;
  name: string;
  source: UpcomingSource;
  amountMinor: number;
  currency: string;
  dueIso: string;
  // Honest labelling — these are predictions, not confirmed debits.
  label: "Forecast" | "Expected" | "Estimated";
}

/** Available spendable balance = sum of asset-type accounts (available balance when
 *  the bank reports one, else the ledger balance), for the user's base currency. */
async function availableBalanceMinor(userId: string, currency: string): Promise<number> {
  const accounts = await prisma.bankAccount.findMany({
    where: { userId, isArchived: false, currency, accountType: { in: [...ASSET_TYPES] as never } },
    select: { balanceMinor: true, availableBalanceMinor: true },
  });
  return accounts.reduce((s, a) => s + (a.availableBalanceMinor != null ? n(a.availableBalanceMinor) : n(a.balanceMinor)), 0);
}

/** All upcoming outgoing commitments within `days`, from the DD/subscription/standing
 *  order mandates and Phase-1 expected payments. De-duplicated by (name, due day). */
export async function upcomingPayments(userId: string, days: number, now: Date = new Date()): Promise<UpcomingPayment[]> {
  const currency = await primaryCurrencyFor(userId);
  const until = new Date(now.getTime() + days * DAY);

  // Canonical recurring commitments (DD, subscriptions, standing orders, recurring card).
  const mandates = await prisma.directDebitMandate.findMany({
    where: { userId, status: { in: ["ACTIVE", "UNKNOWN"] }, nextExpectedAt: { gte: startOfUtcDay(now), lte: until } },
    select: { id: true, companyName: true, kind: true, nextExpectedAt: true, expectedAmountMinor: true, userExpectedAmountMinor: true, lastAmountMinor: true },
  });
  const items: UpcomingPayment[] = mandates.map((m) => ({
    id: m.id,
    name: m.companyName,
    source: m.kind as UpcomingSource,
    amountMinor: m.userExpectedAmountMinor ?? m.expectedAmountMinor ?? m.lastAmountMinor ?? 0,
    currency,
    dueIso: m.nextExpectedAt!.toISOString(),
    label: "Expected",
  }));

  // Phase-1 expected payments (manual recurring / projected).
  const expected = await prisma.expectedPayment.findMany({
    where: { userId, status: { in: ["PROJECTED", "DUE", "OVERDUE"] }, dueDate: { gte: startOfUtcDay(now), lte: until } },
    include: { recurring: { select: { merchantName: true, currency: true } } },
  });
  const seen = new Set(items.map((i) => `${i.name.toLowerCase()}|${i.dueIso.slice(0, 10)}`));
  for (const e of expected) {
    const key = `${e.recurring.merchantName.toLowerCase()}|${e.dueDate.toISOString().slice(0, 10)}`;
    if (seen.has(key)) continue; // already covered by a mandate
    items.push({
      id: e.id,
      name: e.recurring.merchantName,
      source: "EXPECTED_PAYMENT",
      amountMinor: n(e.expectedAmountMinor),
      currency: e.recurring.currency,
      dueIso: e.dueDate.toISOString(),
      label: "Forecast",
    });
  }
  return items.filter((i) => i.currency === currency).sort((a, b) => a.dueIso.localeCompare(b.dueIso));
}

export interface CashFlowHorizon {
  outflowMinor: number;
  inflowMinor: number;
  netMinor: number;
  projectedBalanceMinor: number;
}
export interface CashFlowForecast {
  currency: string;
  currentBalanceMinor: number;
  next7: CashFlowHorizon;
  next30: CashFlowHorizon;
  endOfMonth: CashFlowHorizon;
  label: "Estimate";
  upcoming: UpcomingPayment[];
}

/** Detected recurring income (e.g. salary) expected within `days`. Kept deliberately
 *  simple and conservative: a monthly-cadence income stream from the same source. */
async function upcomingIncomeMinor(userId: string, currency: string, now: Date, until: Date): Promise<number> {
  const lookback = new Date(now.getTime() - 100 * DAY);
  const incomes = await prisma.transaction.findMany({
    where: {
      userId, direction: "INCOME", currency, merchantId: { not: null }, bookedAt: { gte: lookback },
      ...NON_TRANSFER_WHERE,
    },
    select: { merchantId: true, amountMinor: true, bookedAt: true },
    orderBy: { bookedAt: "asc" },
  });
  const byMerchant = new Map<string, { amounts: number[]; dates: Date[] }>();
  for (const t of incomes) {
    const g = byMerchant.get(t.merchantId!) ?? { amounts: [], dates: [] };
    g.amounts.push(n(t.amountMinor)); g.dates.push(t.bookedAt);
    byMerchant.set(t.merchantId!, g);
  }
  let total = 0;
  for (const g of byMerchant.values()) {
    if (g.dates.length < 2) continue; // need a repeat to call it recurring income
    const last = g.dates[g.dates.length - 1]!;
    const predictedNext = new Date(last.getTime() + 30 * DAY);
    if (predictedNext >= now && predictedNext <= until) {
      total += Math.round(g.amounts.reduce((a, b) => a + b, 0) / g.amounts.length);
    }
  }
  return total;
}

export async function cashFlowForecast(userId: string, tz: string, now: Date = new Date()): Promise<CashFlowForecast> {
  const currency = await primaryCurrencyFor(userId);
  const current = await availableBalanceMinor(userId, currency);
  const all = await upcomingPayments(userId, 45, now);

  const horizon = async (end: Date): Promise<CashFlowHorizon> => {
    const outflow = all.filter((i) => new Date(i.dueIso) <= end).reduce((s, i) => s + i.amountMinor, 0);
    const inflow = await upcomingIncomeMinor(userId, currency, now, end);
    return { outflowMinor: outflow, inflowMinor: inflow, netMinor: inflow - outflow, projectedBalanceMinor: current + inflow - outflow };
  };

  const next7 = await horizon(new Date(now.getTime() + 7 * DAY));
  const next30 = await horizon(new Date(now.getTime() + 30 * DAY));
  const endOfMonth = await horizon(monthRange(tz, now).end);

  return { currency, currentBalanceMinor: current, next7, next30, endOfMonth, label: "Estimate", upcoming: all.slice(0, 20) };
}

export interface SafeToSpend {
  currency: string;
  availableMinor: number;
  upcomingCommittedMinor: number;
  minReserveMinor: number;
  safeToSpendMinor: number;
  label: "Estimate";
}

/** Safe-to-spend = available − upcoming committed (next 30 days) − configurable
 *  minimum reserve. Clearly an estimate. */
export async function safeToSpend(userId: string, minReserveMinor = 0, now: Date = new Date()): Promise<SafeToSpend> {
  const currency = await primaryCurrencyFor(userId);
  const available = await availableBalanceMinor(userId, currency);
  const upcoming = await upcomingPayments(userId, 30, now);
  const committed = upcoming.reduce((s, i) => s + i.amountMinor, 0);
  return {
    currency,
    availableMinor: available,
    upcomingCommittedMinor: committed,
    minReserveMinor,
    safeToSpendMinor: available - committed - minReserveMinor,
    label: "Estimate",
  };
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Re-export the existing Phase-2 DD upcoming helper for callers that want the DD-only
// list (kept for backward compatibility with existing routes).
export { getUpcomingPayments };
