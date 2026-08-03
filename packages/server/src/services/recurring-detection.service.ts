import type { Frequency } from "@prisma/client";
import { prisma } from "../db.js";
import { absMinor } from "@direct-banking/shared";

export interface RecurringSuggestion {
  merchantId: string;
  merchantName: string;
  accountId: string;
  averageAmountMinor: number;
  occurrences: number;
  medianIntervalDays: number;
  suggestedFrequency: Frequency;
  lastSeen: string;
}

export type AlertType =
  | "AMOUNT_CHANGED"
  | "EARLY_PAYMENT"
  | "LATE_PAYMENT"
  | "MISSING_PAYMENT"
  | "DUPLICATE"
  | "NEW_SUBSCRIPTION";

export interface Alert {
  type: AlertType;
  severity: "info" | "warning";
  title: string;
  detail: string;
  amountMinor?: number;
  date?: string;
  merchantName?: string;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function frequencyFromDays(days: number): Frequency {
  if (days <= 9) return "WEEKLY";
  if (days <= 18) return "FORTNIGHTLY";
  if (days <= 24) return "FOUR_WEEKLY";
  if (days <= 45) return "MONTHLY";
  if (days <= 135) return "QUARTERLY";
  if (days <= 250) return "BIANNUAL";
  return "ANNUAL";
}

/** Suggest recurring patterns from expense history not already tracked. */
export async function suggestRecurring(userId: string, lookbackDays = 200): Promise<RecurringSuggestion[]> {
  const since = new Date(Date.now() - lookbackDays * 86_400_000);
  const txns = await prisma.transaction.findMany({
    where: {
      userId,
      direction: "EXPENSE",
      status: { in: ["COMPLETED", "PENDING"] },
      merchantId: { not: null },
      bookedAt: { gte: since },
    },
    select: { merchantId: true, accountId: true, amountMinor: true, bookedAt: true, merchant: { select: { displayName: true } } },
    orderBy: { bookedAt: "asc" },
  });

  const tracked = new Set(
    (await prisma.recurringPayment.findMany({ where: { userId, status: "ACTIVE", merchantId: { not: null } }, select: { merchantId: true } }))
      .map((r) => r.merchantId!)
      .filter(Boolean),
  );

  const groups = new Map<string, typeof txns>();
  for (const t of txns) {
    if (!t.merchantId || tracked.has(t.merchantId)) continue;
    const arr = groups.get(t.merchantId) ?? [];
    arr.push(t);
    groups.set(t.merchantId, arr);
  }

  const suggestions: RecurringSuggestion[] = [];
  for (const [merchantId, items] of groups) {
    if (items.length < 3) continue;
    const intervals: number[] = [];
    for (let i = 1; i < items.length; i++) {
      intervals.push(Math.round((items[i]!.bookedAt.getTime() - items[i - 1]!.bookedAt.getTime()) / 86_400_000));
    }
    const medInterval = median(intervals);
    if (medInterval < 5) continue; // too frequent to be a subscription
    // amounts must be reasonably consistent
    const amounts = items.map((t) => Number(t.amountMinor));
    const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const spread = Math.max(...amounts) - Math.min(...amounts);
    if (avg > 0 && spread / avg > 0.5) continue;

    suggestions.push({
      merchantId,
      merchantName: items[0]!.merchant?.displayName ?? "Unknown",
      accountId: items[items.length - 1]!.accountId,
      averageAmountMinor: Math.round(avg),
      occurrences: items.length,
      medianIntervalDays: medInterval,
      suggestedFrequency: frequencyFromDays(medInterval),
      lastSeen: items[items.length - 1]!.bookedAt.toISOString(),
    });
  }
  return suggestions.sort((a, b) => b.occurrences - a.occurrences);
}

/** Detect anomalies: amount changes, early/late/missing payments, duplicates. */
export async function detectAnomalies(userId: string): Promise<Alert[]> {
  const now = new Date();
  const alerts: Alert[] = [];

  // Missing / overdue expected payments.
  const overdue = await prisma.expectedPayment.findMany({
    where: { userId, status: { in: ["PROJECTED", "DUE", "OVERDUE"] }, dueDate: { lt: now } },
    include: { recurring: true },
    orderBy: { dueDate: "asc" },
    take: 20,
  });
  for (const e of overdue) {
    alerts.push({
      type: "MISSING_PAYMENT",
      severity: "warning",
      title: `Expected payment not seen: ${e.recurring.merchantName}`,
      detail: `Due ${e.dueDate.toISOString().slice(0, 10)} but no matching transaction found yet.`,
      amountMinor: Number(e.expectedAmountMinor),
      date: e.dueDate.toISOString(),
      merchantName: e.recurring.merchantName,
    });
  }

  // Amount changed / timing anomalies on recently matched payments.
  const matched = await prisma.expectedPayment.findMany({
    where: { userId, status: "PAID", dueDate: { gte: new Date(now.getTime() - 60 * 86_400_000) } },
    include: { recurring: true, matchedTransactions: { orderBy: { bookedAt: "desc" }, take: 1 } },
  });
  for (const e of matched) {
    const txn = e.matchedTransactions[0];
    if (!txn) continue;
    const diff = absMinor(txn.amountMinor - e.expectedAmountMinor);
    if (e.expectedAmountMinor > 0n && diff > e.expectedAmountMinor / 10n) {
      alerts.push({
        type: "AMOUNT_CHANGED",
        severity: "warning",
        title: `Amount changed: ${e.recurring.merchantName}`,
        detail: `Expected ${Number(e.expectedAmountMinor) / 100} but charged ${Number(txn.amountMinor) / 100}.`,
        amountMinor: Number(txn.amountMinor),
        date: txn.bookedAt.toISOString(),
        merchantName: e.recurring.merchantName,
      });
    }
    const daysOff = Math.round((txn.bookedAt.getTime() - e.dueDate.getTime()) / 86_400_000);
    if (daysOff <= -3) {
      alerts.push({
        type: "EARLY_PAYMENT",
        severity: "info",
        title: `Early payment: ${e.recurring.merchantName}`,
        detail: `Charged ${Math.abs(daysOff)} day(s) before the expected date.`,
        date: txn.bookedAt.toISOString(),
        merchantName: e.recurring.merchantName,
      });
    } else if (daysOff >= 3) {
      alerts.push({
        type: "LATE_PAYMENT",
        severity: "info",
        title: `Late payment: ${e.recurring.merchantName}`,
        detail: `Charged ${daysOff} day(s) after the expected date.`,
        date: txn.bookedAt.toISOString(),
        merchantName: e.recurring.merchantName,
      });
    }
  }

  // Duplicate transactions (same dedupe hash more than once).
  const dupes = await prisma.transaction.groupBy({
    by: ["dedupeHash"],
    where: { userId, dedupeHash: { not: null }, bookedAt: { gte: new Date(now.getTime() - 45 * 86_400_000) } },
    _count: { _all: true },
    having: { dedupeHash: { _count: { gt: 1 } } },
  });
  for (const d of dupes) {
    if (!d.dedupeHash) continue;
    const sample = await prisma.transaction.findFirst({ where: { userId, dedupeHash: d.dedupeHash }, orderBy: { bookedAt: "desc" } });
    alerts.push({
      type: "DUPLICATE",
      severity: "warning",
      title: `Possible duplicate: ${sample?.description ?? "transaction"}`,
      detail: `${d._count._all} transactions look identical.`,
      amountMinor: sample ? Number(sample.amountMinor) : undefined,
      date: sample?.bookedAt.toISOString(),
    });
  }

  // Possible new subscriptions.
  const suggestions = await suggestRecurring(userId);
  for (const s of suggestions.slice(0, 5)) {
    alerts.push({
      type: "NEW_SUBSCRIPTION",
      severity: "info",
      title: `Possible subscription: ${s.merchantName}`,
      detail: `${s.occurrences} similar charges roughly every ${s.medianIntervalDays} days.`,
      amountMinor: s.averageAmountMinor,
      merchantName: s.merchantName,
    });
  }

  return alerts;
}
