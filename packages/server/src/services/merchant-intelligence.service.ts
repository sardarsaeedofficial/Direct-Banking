import { prisma } from "../db.js";
import { monthRange, yearRange } from "./period.service.js";

// Merchant intelligence (Phase 4 §4). Builds a spend profile for a normalised
// merchant from the canonical ledger. Merchants are only ever merged on an exact
// normalised-key match (see merchant-normalise.service) — never on weak similarity —
// so two different shops are never collapsed into one profile here.

function n(v: bigint | null | undefined): number {
  return v == null ? 0 : Number(v);
}

export interface MerchantProfile {
  id: string;
  displayName: string;
  categoryId: string | null;
  categoryName: string | null;
  currency: string;
  totalSpentMinor: number;
  thisMonthMinor: number;
  thisYearMinor: number;
  averageMinor: number;
  txnCount: number;
  firstSeenIso: string | null;
  lastSeenIso: string | null;
  highestMinor: number;
  isRecurring: boolean;
}

/** Full spend profile for one merchant the user owns, or null if not found/owned. */
export async function merchantProfile(userId: string, merchantId: string, tz: string): Promise<MerchantProfile | null> {
  const merchant = await prisma.merchant.findFirst({
    where: { id: merchantId, userId },
    select: { id: true, displayName: true, defaultCategoryId: true, defaultCategory: { select: { name: true } } },
  });
  if (!merchant) return null;

  // All settled/completed non-cancelled expenses for this merchant.
  const baseWhere = { userId, merchantId, direction: "EXPENSE" as const, status: { not: "CANCELLED" as const } };
  const [totals, monthAgg, yearAgg, firstTxn, lastTxn, highest, currencyRow, recurringCount] = await Promise.all([
    prisma.transaction.aggregate({ where: baseWhere, _sum: { amountMinor: true }, _count: { _all: true } }),
    prisma.transaction.aggregate({ where: { ...baseWhere, bookedAt: rangeFilter(monthRange(tz)) }, _sum: { amountMinor: true } }),
    prisma.transaction.aggregate({ where: { ...baseWhere, bookedAt: rangeFilter(yearRange(tz)) }, _sum: { amountMinor: true } }),
    prisma.transaction.findFirst({ where: baseWhere, orderBy: { bookedAt: "asc" }, select: { bookedAt: true } }),
    prisma.transaction.findFirst({ where: baseWhere, orderBy: { bookedAt: "desc" }, select: { bookedAt: true, currency: true } }),
    prisma.transaction.aggregate({ where: baseWhere, _max: { amountMinor: true } }),
    prisma.transaction.findFirst({ where: baseWhere, orderBy: { bookedAt: "desc" }, select: { currency: true } }),
    prisma.recurringPayment.count({ where: { userId, merchantId, status: { in: ["ACTIVE", "PAUSED"] } } }),
  ]);

  const count = totals._count._all;
  const total = n(totals._sum.amountMinor);
  // A merchant is recurring if it has a recurring payment/subscription, OR its
  // transactions were flagged recurring by the DD/subscription engine.
  const flaggedRecurring = await prisma.transaction.count({ where: { ...baseWhere, recurringKind: { not: null } } });

  return {
    id: merchant.id,
    displayName: merchant.displayName,
    categoryId: merchant.defaultCategoryId,
    categoryName: merchant.defaultCategory?.name ?? null,
    currency: currencyRow?.currency ?? "GBP",
    totalSpentMinor: total,
    thisMonthMinor: n(monthAgg._sum.amountMinor),
    thisYearMinor: n(yearAgg._sum.amountMinor),
    averageMinor: count > 0 ? Math.round(total / count) : 0,
    txnCount: count,
    firstSeenIso: firstTxn?.bookedAt.toISOString() ?? null,
    lastSeenIso: lastTxn?.bookedAt.toISOString() ?? null,
    highestMinor: n(highest._max.amountMinor),
    isRecurring: recurringCount > 0 || flaggedRecurring > 0,
  };
}

function rangeFilter(r: { start: Date; end: Date }) {
  return { gte: r.start, lt: r.end };
}
