import type { Prisma, RecurringKind } from "@prisma/client";
import { prisma } from "../db.js";
import { median, medianIntervalDays, predictedAmount, predictNextDate } from "./direct-debit.service.js";
import { effectiveExpectation, type MandateLike } from "./direct-debit.service.js";

// Recurring-payment & subscription intelligence (Phase 4 §7–10). Subscriptions and
// recurring card payments are stored as DirectDebitMandate rows with a non-DD `kind`,
// so all recurring commitments share one canonical model and the combined view is a
// single query. This engine NEVER touches rows that already belong to the Direct
// Debit engine (transactionType DIRECT_DEBIT / linked mandate) — a DD is never
// reclassified as a subscription.

const DAY = 86_400_000;

// Well-known card-subscription merchants (normalised substring → treat as SUBSCRIPTION
// rather than a generic RECURRING_CARD). Conservative and additive.
const SUBSCRIPTION_MERCHANTS = ["netflix", "spotify", "disney", "audible", "youtube", "hbo", "hulu", "patreon", "notion", "icloud", "amazonprime", "primevideo"];

export type RecurringConfidence = "CONFIRMED" | "HIGH_CONFIDENCE" | "POSSIBLE" | "NOT_RECURRING";

export interface SubscriptionSuggestion {
  merchantId: string;
  merchantName: string;
  accountId: string;
  occurrences: number;
  averageAmountMinor: number;
  medianIntervalDays: number;
  amountSpreadPct: number;
  intervalCvPct: number;
  confidence: RecurringConfidence;
  kind: RecurringKind;
  lastSeenIso: string;
}

function coefficientOfVariation(nums: number[]): number {
  if (nums.length < 2) return 1;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (mean === 0) return 1;
  const variance = nums.reduce((s, x) => s + (x - mean) ** 2, 0) / nums.length;
  return Math.sqrt(variance) / mean;
}

function classify(occurrences: number, amountSpreadPct: number, intervalCvPct: number, medInterval: number): RecurringConfidence {
  // Guard: a subscription must recur at least ~weekly-to-annually and never be
  // decided from only two charges.
  if (occurrences < 3 || medInterval < 5) return "NOT_RECURRING";
  const tightAmount = amountSpreadPct <= 15;
  const tightInterval = intervalCvPct <= 25;
  if (occurrences >= 4 && tightAmount && tightInterval) return "CONFIRMED";
  if (occurrences >= 3 && amountSpreadPct <= 30 && intervalCvPct <= 40) return "HIGH_CONFIDENCE";
  if (occurrences >= 3 && amountSpreadPct <= 60) return "POSSIBLE";
  return "NOT_RECURRING";
}

function kindFor(merchantName: string): RecurringKind {
  const key = merchantName.toLowerCase().replace(/\s+/g, "");
  return SUBSCRIPTION_MERCHANTS.some((m) => key.includes(m)) ? "SUBSCRIPTION" : "RECURRING_CARD";
}

/**
 * Detect card-based subscriptions / recurring card payments from history. Only
 * card-style expenses are considered — anything already owned by the Direct Debit
 * engine is excluded, so Direct Debits are never re-labelled as subscriptions.
 */
export async function detectSubscriptions(userId: string, lookbackDays = 220): Promise<SubscriptionSuggestion[]> {
  const since = new Date(Date.now() - lookbackDays * DAY);
  const txns = await prisma.transaction.findMany({
    where: {
      userId,
      direction: "EXPENSE",
      status: { in: ["COMPLETED", "PENDING"] },
      merchantId: { not: null },
      directDebitMandateId: null, // not already a DD/subscription mandate payment
      transactionType: { not: "DIRECT_DEBIT" },
      bookedAt: { gte: since },
    },
    select: { merchantId: true, accountId: true, amountMinor: true, bookedAt: true, merchant: { select: { displayName: true } } },
    orderBy: { bookedAt: "asc" },
  });

  const groups = new Map<string, typeof txns>();
  for (const t of txns) {
    if (!t.merchantId) continue;
    const arr = groups.get(t.merchantId) ?? [];
    arr.push(t);
    groups.set(t.merchantId, arr);
  }

  const suggestions: SubscriptionSuggestion[] = [];
  for (const [merchantId, items] of groups) {
    if (items.length < 3) continue;
    const intervals: number[] = [];
    for (let i = 1; i < items.length; i++) intervals.push(Math.round((items[i]!.bookedAt.getTime() - items[i - 1]!.bookedAt.getTime()) / DAY));
    const medInterval = median(intervals);
    const amounts = items.map((t) => Number(t.amountMinor));
    const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const spread = avg > 0 ? (Math.max(...amounts) - Math.min(...amounts)) / avg : 1;
    const cv = coefficientOfVariation(intervals);
    const confidence = classify(items.length, spread * 100, cv * 100, medInterval);
    if (confidence === "NOT_RECURRING") continue;
    const name = items[0]!.merchant?.displayName ?? "Unknown";
    suggestions.push({
      merchantId,
      merchantName: name,
      accountId: items[items.length - 1]!.accountId,
      occurrences: items.length,
      averageAmountMinor: Math.round(avg),
      medianIntervalDays: medInterval,
      amountSpreadPct: Math.round(spread * 100),
      intervalCvPct: Math.round(cv * 100),
      confidence,
      kind: kindFor(name),
      lastSeenIso: items[items.length - 1]!.bookedAt.toISOString(),
    });
  }
  return suggestions.sort((a, b) => b.occurrences - a.occurrences);
}

/**
 * Auto-create/update mandates for strongly-detected subscriptions (CONFIRMED /
 * HIGH_CONFIDENCE only). POSSIBLE suggestions are returned for review and never
 * auto-created. Returns the number of mandates created. Idempotent: an existing
 * subscription mandate for the same company/account is updated, not duplicated.
 */
export async function syncStrongSubscriptions(userId: string): Promise<{ created: number; reviewable: SubscriptionSuggestion[] }> {
  const suggestions = await detectSubscriptions(userId);
  const strong = suggestions.filter((s) => s.confidence === "CONFIRMED" || s.confidence === "HIGH_CONFIDENCE");
  const reviewable = suggestions.filter((s) => s.confidence === "POSSIBLE");
  let created = 0;

  for (const s of strong) {
    const normalized = s.merchantName.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const existing = await prisma.directDebitMandate.findUnique({
      where: { userId_accountId_normalizedCompanyName: { userId, accountId: s.accountId, normalizedCompanyName: normalized } },
      select: { id: true },
    });
    if (existing) continue; // already tracked (as a subscription or DD) — never duplicate
    const dates = await prisma.transaction.findMany({
      where: { userId, merchantId: s.merchantId, direction: "EXPENSE" },
      select: { bookedAt: true }, orderBy: { bookedAt: "asc" },
    });
    const amounts = [s.averageAmountMinor];
    const pred = predictedAmount(amounts);
    const nextExpectedAt = predictNextDate(dates.map((d) => d.bookedAt), "MONTHLY", null) ?? undefined;
    await prisma.directDebitMandate.create({
      data: {
        userId,
        accountId: s.accountId,
        companyName: s.merchantName,
        normalizedCompanyName: normalized,
        kind: s.kind,
        status: "ACTIVE",
        expectedAmountMinor: pred.amountMinor,
        expectedMinMinor: pred.minMinor,
        expectedMaxMinor: pred.maxMinor,
        nextExpectedAt,
        lastAmountMinor: s.averageAmountMinor,
        paymentCount: s.occurrences,
        firstSeenAt: since220(),
      },
    });
    created += 1;
  }
  return { created, reviewable };
}

function since220(): Date {
  return new Date(Date.now() - 220 * DAY);
}

export interface RecurringPaymentItem {
  id: string;
  companyName: string;
  kind: RecurringKind;
  status: string;
  accountId: string;
  accountName: string;
  expectedAmountMinor: number;
  currency: string;
  nextExpectedIso: string | null;
  lastAmountMinor: number | null;
  paymentCount: number;
}

export interface RecurringPaymentsView {
  items: RecurringPaymentItem[];
  byKind: Record<string, RecurringPaymentItem[]>;
  monthlyTotalMinor: number;
  annualTotalMinor: number;
  activeCount: number;
}

// Rough monthly-equivalent factor by learned frequency, for a monthly spend estimate.
function monthlyFactor(frequency: string): number {
  switch (frequency) {
    case "WEEKLY": return 52 / 12;
    case "FORTNIGHTLY": return 26 / 12;
    case "FOUR_WEEKLY": return 13 / 12;
    case "QUARTERLY": return 1 / 3;
    case "BIANNUAL": return 1 / 6;
    case "ANNUAL": return 1 / 12;
    case "MONTHLY":
    default: return 1;
  }
}

/**
 * Combined "recurring payments" view across every canonical recurring commitment
 * (Direct Debits, subscriptions, recurring card payments, standing orders). Monthly
 * and annual totals normalise each item's expected amount by its frequency.
 */
export async function recurringPaymentsView(userId: string): Promise<RecurringPaymentsView> {
  const mandates = await prisma.directDebitMandate.findMany({
    where: { userId, status: { not: "CANCELLED" } },
    include: { account: { select: { nickname: true, bankName: true, currency: true } } },
    orderBy: [{ kind: "asc" }, { companyName: "asc" }],
  });
  const items: RecurringPaymentItem[] = mandates.map((m) => {
    const e = effectiveExpectation(m as unknown as MandateLike);
    return {
      id: m.id,
      companyName: m.companyName,
      kind: m.kind,
      status: m.status,
      accountId: m.accountId,
      accountName: m.account.nickname || m.account.bankName,
      expectedAmountMinor: e.point ?? m.lastAmountMinor ?? 0,
      currency: m.account.currency,
      nextExpectedIso: (m.userExpectedDate ?? m.nextExpectedAt)?.toISOString() ?? null,
      lastAmountMinor: m.lastAmountMinor,
      paymentCount: m.paymentCount,
    };
  });

  const byKind: Record<string, RecurringPaymentItem[]> = {};
  let monthly = 0;
  for (const it of items) {
    (byKind[it.kind] ??= []).push(it);
    const m = mandates.find((x) => x.id === it.id)!;
    monthly += Math.round(it.expectedAmountMinor * monthlyFactor(m.frequency));
  }
  return {
    items,
    byKind,
    monthlyTotalMinor: monthly,
    annualTotalMinor: monthly * 12,
    activeCount: items.filter((i) => i.status === "ACTIVE").length,
  };
}
