import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import {
  monthRange, prevMonthRange, yearRange, prevYearRange, rangeForPeriod,
  type DateRange, type PeriodKind,
} from "./period.service.js";

// ---------------------------------------------------------------------------
// Shared exclusions
// ---------------------------------------------------------------------------
// Own-account transfers and cancelled rows are never income or spending. This
// `where` fragment centralises that so every insight applies the same rule.
// NULL-safety matters here: `transactionType` is nullable, so any predicate of the
// form `transactionType = 'TRANSFER'` (whether via `{ not }` or inside a `NOT(OR)`)
// evaluates to NULL for NULL-typed rows and silently drops every simple/legacy
// transaction. We therefore AND together NULL-safe equalities (`IS NULL` on the
// transfer link columns, non-null `direction`) and handle the nullable type with an
// explicit OR that keeps NULL-typed rows.
// Credit-card repayments are excluded the same way transfers are (Financial
// Event Intelligence, §3/§31): the purchases on the card were the real
// economic expense, so counting the repayment itself as spending would
// double-count. It is a real, completed cash movement — just not ordinary
// consumer spending — so it stays visible in Activity and net worth, only
// excluded from these income/spending/budget/merchant aggregates.
//
// A REFUNDED original is also excluded (Financial Event Intelligence, §26): a
// purchase that was fully reversed was never real net spending. Its offsetting
// correction transaction (transactionType REFUND, created by reconciliation)
// is excluded too, so a refund doesn't inflate income either — the pair
// cancels out of these aggregates entirely rather than each half counting on
// its own side.
export const NON_TRANSFER_WHERE: Prisma.TransactionWhereInput = {
  status: { notIn: ["CANCELLED", "REFUNDED"] },
  direction: { not: "TRANSFER" },
  transferAccountId: null,
  internalTransferGroupId: null,
  OR: [
    { transactionType: null },
    { transactionType: { notIn: ["TRANSFER", "INTERNAL_TRANSFER", "CREDIT_CARD_REPAYMENT", "REFUND"] } },
  ],
};

function n(v: bigint | null | undefined): number {
  return v == null ? 0 : Number(v);
}

// ---------------------------------------------------------------------------
// Monthly summary (per currency — currencies are never silently combined, §25)
// ---------------------------------------------------------------------------
export interface CurrencySummary {
  currency: string;
  incomeMinor: number;
  spendingMinor: number;
  netMinor: number;
  // Fraction of income not spent, in basis points (0–10000). null when income is 0.
  savingsRateBps: number | null;
}

export interface PeriodSummary {
  range: { startIso: string; endIso: string };
  primaryCurrency: string;
  currencies: CurrencySummary[];
}

async function summariseRange(userId: string, range: DateRange): Promise<CurrencySummary[]> {
  const rows = await prisma.transaction.groupBy({
    by: ["currency", "direction"],
    where: { userId, bookedAt: { gte: range.start, lt: range.end }, ...NON_TRANSFER_WHERE },
    _sum: { amountMinor: true },
  });
  const byCurrency = new Map<string, { income: number; spending: number }>();
  for (const r of rows) {
    const bucket = byCurrency.get(r.currency) ?? { income: 0, spending: 0 };
    if (r.direction === "INCOME") bucket.income += n(r._sum.amountMinor);
    else if (r.direction === "EXPENSE") bucket.spending += n(r._sum.amountMinor);
    byCurrency.set(r.currency, bucket);
  }
  return [...byCurrency.entries()].map(([currency, b]) => {
    const net = b.income - b.spending;
    return {
      currency,
      incomeMinor: b.income,
      spendingMinor: b.spending,
      netMinor: net,
      // Savings rate = (income − spending) / income. Undefined when no income.
      savingsRateBps: b.income > 0 ? Math.round((net / b.income) * 10000) : null,
    };
  });
}

export async function monthlySummary(userId: string, tz: string, ref: Date = new Date()): Promise<PeriodSummary> {
  const range = monthRange(tz, ref);
  const currencies = await summariseRange(userId, range);
  const primaryCurrency = await primaryCurrencyFor(userId);
  ensureCurrency(currencies, primaryCurrency);
  return { range: { startIso: range.start.toISOString(), endIso: range.end.toISOString() }, primaryCurrency, currencies };
}

// ---------------------------------------------------------------------------
// Period comparison (this vs previous) with safe zero handling (§12)
// ---------------------------------------------------------------------------
export interface ComparisonMetric {
  currentMinor: number;
  previousMinor: number;
  deltaMinor: number;
  // Percent change vs previous. null when previous is 0 (avoids a misleading ∞/NaN).
  changePct: number | null;
}
export interface Comparison {
  currency: string;
  income: ComparisonMetric;
  spending: ComparisonMetric;
  net: ComparisonMetric;
}

function metric(current: number, previous: number): ComparisonMetric {
  const delta = current - previous;
  return { currentMinor: current, previousMinor: previous, deltaMinor: delta, changePct: previous === 0 ? null : Math.round((delta / Math.abs(previous)) * 1000) / 10 };
}

export async function periodComparison(
  userId: string,
  tz: string,
  basis: "month" | "year",
  ref: Date = new Date(),
): Promise<{ basis: string; currency: string; comparisons: Comparison[] }> {
  const [cur, prev] = basis === "year"
    ? [yearRange(tz, ref), prevYearRange(tz, ref)]
    : [monthRange(tz, ref), prevMonthRange(tz, ref)];
  const [curSum, prevSum] = await Promise.all([summariseRange(userId, cur), summariseRange(userId, prev)]);
  const currencies = new Set<string>([...curSum.map((c) => c.currency), ...prevSum.map((c) => c.currency)]);
  const comparisons: Comparison[] = [...currencies].map((currency) => {
    const c = curSum.find((x) => x.currency === currency);
    const p = prevSum.find((x) => x.currency === currency);
    return {
      currency,
      income: metric(c?.incomeMinor ?? 0, p?.incomeMinor ?? 0),
      spending: metric(c?.spendingMinor ?? 0, p?.spendingMinor ?? 0),
      net: metric(c?.netMinor ?? 0, p?.netMinor ?? 0),
    };
  });
  const primary = await primaryCurrencyFor(userId);
  return { basis, currency: primary, comparisons };
}

// ---------------------------------------------------------------------------
// Category breakdown (§13) — single currency, children rolled up to parents
// ---------------------------------------------------------------------------
export interface CategorySlice {
  categoryId: string | null;
  name: string;
  code: string | null;
  colour: string;
  spentMinor: number;
  txnCount: number;
  pctBps: number; // share of total spending in basis points
}

export async function categoryBreakdown(
  userId: string,
  tz: string,
  kind: PeriodKind,
  opts: { ref?: Date; customStart?: Date; customEnd?: Date; currency?: string } = {},
): Promise<{ range: { startIso: string; endIso: string }; currency: string; totalMinor: number; categories: CategorySlice[] }> {
  const range = rangeForPeriod(kind, tz, opts);
  const currency = opts.currency ?? (await primaryCurrencyFor(userId));
  const rows = await prisma.transaction.groupBy({
    by: ["categoryId"],
    where: { userId, currency, direction: "EXPENSE", bookedAt: { gte: range.start, lt: range.end }, ...NON_TRANSFER_WHERE },
    _sum: { amountMinor: true },
    _count: { _all: true },
  });
  // Roll any child category up to its parent so the breakdown is top-level.
  const cats = await prisma.category.findMany({ where: { userId }, select: { id: true, name: true, code: true, colour: true, parentId: true } });
  const catById = new Map(cats.map((c) => [c.id, c]));
  const agg = new Map<string | null, { spent: number; count: number }>();
  for (const r of rows) {
    let key = r.categoryId;
    if (key) { const c = catById.get(key); if (c?.parentId) key = c.parentId; }
    const bucket = agg.get(key) ?? { spent: 0, count: 0 };
    bucket.spent += n(r._sum.amountMinor);
    bucket.count += r._count._all;
    agg.set(key, bucket);
  }
  const total = [...agg.values()].reduce((s, b) => s + b.spent, 0);
  const categories: CategorySlice[] = [...agg.entries()].map(([categoryId, b]) => {
    const c = categoryId ? catById.get(categoryId) : undefined;
    return {
      categoryId,
      name: c?.name ?? "Uncategorized",
      code: c?.code ?? null,
      colour: c?.colour ?? "#64748b",
      spentMinor: b.spent,
      txnCount: b.count,
      pctBps: total > 0 ? Math.round((b.spent / total) * 10000) : 0,
    };
  }).sort((a, b) => b.spentMinor - a.spentMinor);
  return { range: { startIso: range.start.toISOString(), endIso: range.end.toISOString() }, currency, totalMinor: total, categories };
}

// ---------------------------------------------------------------------------
// Top merchants (§14) — single currency
// ---------------------------------------------------------------------------
export interface MerchantSlice {
  merchantId: string;
  displayName: string;
  spentMinor: number;
  txnCount: number;
}

export async function topMerchants(
  userId: string,
  tz: string,
  kind: PeriodKind,
  opts: { ref?: Date; customStart?: Date; customEnd?: Date; currency?: string; limit?: number } = {},
): Promise<{ range: { startIso: string; endIso: string }; currency: string; merchants: MerchantSlice[] }> {
  const range = rangeForPeriod(kind, tz, opts);
  const currency = opts.currency ?? (await primaryCurrencyFor(userId));
  const rows = await prisma.transaction.groupBy({
    by: ["merchantId"],
    where: { userId, currency, direction: "EXPENSE", merchantId: { not: null }, bookedAt: { gte: range.start, lt: range.end }, ...NON_TRANSFER_WHERE },
    _sum: { amountMinor: true },
    _count: { _all: true },
  });
  rows.sort((a, b) => n(b._sum.amountMinor) - n(a._sum.amountMinor));
  const top = rows.slice(0, opts.limit ?? 10);
  const merchants = await prisma.merchant.findMany({ where: { id: { in: top.map((r) => r.merchantId!) } }, select: { id: true, displayName: true } });
  const nameById = new Map(merchants.map((m) => [m.id, m.displayName]));
  return {
    range: { startIso: range.start.toISOString(), endIso: range.end.toISOString() },
    currency,
    merchants: top.map((r) => ({ merchantId: r.merchantId!, displayName: nameById.get(r.merchantId!) ?? "Unknown", spentMinor: n(r._sum.amountMinor), txnCount: r._count._all })),
  };
}

// ---------------------------------------------------------------------------
// Net worth (§18) — asset/liability split by account type, per currency
// ---------------------------------------------------------------------------
const ASSET_TYPES = new Set(["CURRENT", "SAVINGS", "CASH"]);
const LIABILITY_TYPES = new Set(["CREDIT_CARD", "LOAN"]);

export interface NetWorthAccount {
  id: string;
  name: string;
  accountType: string;
  classification: "ASSET" | "LIABILITY" | "UNCLASSIFIED";
  balanceMinor: number;
}
export interface NetWorthCurrency {
  currency: string;
  assetsMinor: number;
  liabilitiesMinor: number;
  netWorthMinor: number;
  unclassifiedMinor: number;
  accounts: NetWorthAccount[];
}

export async function netWorth(userId: string): Promise<{ currencies: NetWorthCurrency[] }> {
  const accounts = await prisma.bankAccount.findMany({
    where: { userId, isArchived: false },
    select: { id: true, nickname: true, bankName: true, accountType: true, currency: true, balanceMinor: true },
  });
  const byCurrency = new Map<string, NetWorthCurrency>();
  for (const a of accounts) {
    const bal = n(a.balanceMinor);
    const classification: NetWorthAccount["classification"] =
      ASSET_TYPES.has(a.accountType) ? "ASSET" : LIABILITY_TYPES.has(a.accountType) ? "LIABILITY" : "UNCLASSIFIED";
    const entry = byCurrency.get(a.currency) ?? { currency: a.currency, assetsMinor: 0, liabilitiesMinor: 0, netWorthMinor: 0, unclassifiedMinor: 0, accounts: [] };
    if (classification === "ASSET") entry.assetsMinor += bal;
    else if (classification === "LIABILITY") entry.liabilitiesMinor += bal;
    else entry.unclassifiedMinor += bal;
    // True net position is the sum of every real balance; the split is presentational.
    entry.netWorthMinor += bal;
    entry.accounts.push({ id: a.id, name: a.nickname || a.bankName, accountType: a.accountType, classification, balanceMinor: bal });
    byCurrency.set(a.currency, entry);
  }
  return { currencies: [...byCurrency.values()] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export async function primaryCurrencyFor(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { baseCurrency: true } });
  return user?.baseCurrency ?? "GBP";
}

/** Ensure the primary currency always appears (as zeros) so the client can render a
 *  headline even in a month with no activity. */
function ensureCurrency(list: CurrencySummary[], currency: string): void {
  if (!list.some((c) => c.currency === currency)) {
    list.push({ currency, incomeMinor: 0, spendingMinor: 0, netMinor: 0, savingsRateBps: null });
  }
}
