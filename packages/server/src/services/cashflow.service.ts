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
    select: { id: true, companyName: true, merchantAlias: true, kind: true, nextExpectedAt: true, expectedAmountMinor: true, userExpectedAmountMinor: true, lastAmountMinor: true, paymentCount: true, userExpectedDate: true },
  });
  const items: UpcomingPayment[] = mandates.map((m) => ({
    id: m.id,
    // A user-confirmed display alias (§12) always wins for display; mandate
    // identity/matching is keyed on normalizedCompanyName, never this field.
    name: m.merchantAlias ?? m.companyName,
    source: m.kind as UpcomingSource,
    amountMinor: m.userExpectedAmountMinor ?? m.expectedAmountMinor ?? m.lastAmountMinor ?? 0,
    currency,
    dueIso: m.nextExpectedAt!.toISOString(),
    // Direct Debit Intelligence & Reconciliation round (§7/§19): a mandate
    // with EXACTLY one observed payment has had its next date generated
    // purely from a default cadence assumption (recomputeMandate() has no
    // real interval to learn from yet — see direct-debit.service.ts) — real
    // recurring evidence needs at least a second payment to confirm the
    // interval. Never downgrades a mandate with zero payments (e.g. one
    // seeded directly from a bank's own UPCOMING pre-alert via
    // recordUpcomingDirectDebitLike(), or a manually configured commitment —
    // both are genuine evidence on their own, just not "learned from
    // history" yet) or a user-confirmed next date, which is explicit
    // evidence regardless of payment count.
    label: m.paymentCount === 1 && !m.userExpectedDate ? "Forecast" : "Expected",
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
  // Direct Debit Intelligence & Reconciliation round (§6/§19): the horizon
  // was previously an unlabelled implementation detail (a bare literal `30`
  // passed to upcomingPayments()) — documented and surfaced explicitly here
  // so a client can render "Safe to spend over next 30 days (until 21 Sep)"
  // instead of a bare figure with no stated meaning. This is the audited,
  // INTENDED existing horizon (a rolling window from `now`, not "until the
  // end of the current calendar month") — deliberately left as-is rather
  // than silently changed; see cashFlowForecast()'s separate endOfMonth
  // figure for that alternative framing.
  horizonDays: number;
  horizonEndIso: string;
  // Exactly which unresolved occurrences are reducing the figure — lets a
  // user spot a bad prediction immediately instead of only seeing one
  // opaque total (§19). Only HIGH-confidence ("Expected") items are ever
  // counted in upcomingCommittedMinor; low-confidence single-payment
  // forecasts are listed for transparency elsewhere (upcomingPayments()) but
  // never silently reserved against Safe-to-Spend.
  contributingItems: UpcomingPayment[];
}

/** Safe-to-spend = available − upcoming committed (next 30 days) − configurable
 *  minimum reserve. Clearly an estimate.
 *
 *  Only counts HIGH-confidence upcoming obligations toward the committed
 *  figure (§5/§7): a completed payment, a settled expected occurrence, a
 *  cancelled/failed Direct Debit, or a single-payment mandate's own
 *  automatic next-cycle GUESS (label "Forecast" — see upcomingPayments())
 *  must never silently reduce what the user is told is safe to spend. */
export async function safeToSpend(userId: string, minReserveMinor = 0, now: Date = new Date()): Promise<SafeToSpend> {
  const currency = await primaryCurrencyFor(userId);
  const available = await availableBalanceMinor(userId, currency);
  const horizonDays = 30;
  const upcoming = await upcomingPayments(userId, horizonDays, now);
  const contributingItems = upcoming.filter((i) => i.label === "Expected");
  const committed = contributingItems.reduce((s, i) => s + i.amountMinor, 0);
  return {
    currency,
    availableMinor: available,
    upcomingCommittedMinor: committed,
    minReserveMinor,
    safeToSpendMinor: available - committed - minReserveMinor,
    label: "Estimate",
    horizonDays,
    horizonEndIso: new Date(now.getTime() + horizonDays * DAY).toISOString(),
    contributingItems,
  };
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Re-export the existing Phase-2 DD upcoming helper for callers that want the DD-only
// list (kept for backward compatibility with existing routes).
export { getUpcomingPayments };
