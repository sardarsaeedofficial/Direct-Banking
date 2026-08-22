import type { DdAnomaly, DdFrequency, Prisma } from "@prisma/client";
import { prisma } from "../db.js";

// ---------------------------------------------------------------------------
// Direct Debit & recurring-payment engine (Phase 2)
//
// A Direct Debit is a company/mandate that owns a payment history, an expected
// amount/date, alert config and predictions. Payments append to their company's
// history; a company is created the first time a genuine DD is seen and reused
// afterwards (never one company per month).
// ---------------------------------------------------------------------------

// Company-name variations that must not affect matching. Kept conservative so
// unrelated companies are never merged (e.g. "British Airways" ≠ "British Gas").
const COMPANY_SUFFIXES = /\b(services?|ltd|limited|plc|inc|llc|payments?|dd|directdebit|direct debit)\b/g;

/** Stable key that folds harmless name variants together (exact match only, no fuzzy merge). */
export function normaliseCompany(raw: string | null | undefined): string {
  if (!raw) return "";
  const words = raw
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(COMPANY_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
  return words.replace(/\s+/g, ""); // drop spaces → "britishgas" for all "British Gas" variants
}

/** A DD signal in free text (notification wording / bank description). */
export function looksLikeDirectDebit(text: string | null | undefined): boolean {
  if (!text) return false;
  return /\b(direct debit|directdebit|\bdd\b)\b/i.test(text) || /\bdirect\s+debit\b/i.test(text);
}

// ---------------------------------------------------------------------------
// Collector/merchant display-name normalisation (Direct Debit Intelligence &
// Reconciliation round, §3).
//
// A bank notification's own wording frequently runs the collector's name
// straight into the sentence describing what's happening to it ("MANCHESTER
// C C leaves your account ending 7164 this week"), and on-device/best-effort
// merchant extraction can end up keeping a fragment of that trailing wording
// ("Manchester C C Leaves Your") rather than isolating the collector alone.
// This is never fed into a ledger decision — purely a display/identity-key
// cleanup — but it matters a great deal for identity: normaliseCompany()
// folds "Manchester C C" and "Manchester C C Leaves Your" into two DIFFERENT
// keys, which is exactly what silently splits one real-world collector into
// two separate DirectDebitMandate rows (§8). Stripping the trailing action
// wording BEFORE normaliseCompany()/mandate lookup ever sees it keeps one
// collector as one mandate, and also fixes what the user sees on screen.
//
// Deliberately conservative: strips from the FIRST recognised action-phrase
// match onward and falls back to the original string whenever that would
// leave nothing usable — under-cleaning (an odd-looking name) is always
// safer here than over-cleaning (silently truncating a real collector name
// that happens to contain one of these words).
// ---------------------------------------------------------------------------
const COLLECTOR_ACTION_PHRASE_RE = new RegExp(
  [
    "will\\s+leave", "leaves?\\b", "leaving\\b", "is\\s+due\\s+to\\s+leave", "due\\s+to\\s+leave",
    "will\\s+be\\s+(?:taken|collected)", "has\\s+been\\s+(?:taken|collected|paid)", "has\\s+left",
    "we'?ll\\s+take", "we\\s+will\\s+take", "will\\s+take", "\\bdue\\s+on\\b",
    "account\\s+ending", "ending\\s+(?:with\\s+)?\\d", "\\bthis\\s+week\\b", "\\btomorrow\\b", "\\btoday\\b",
  ].join("|"),
  "i",
);

/** Clean a raw collector/merchant candidate string down to just the
 *  collector's own name, stripping any trailing notification wording. Safe,
 *  idempotent no-op for a string that never contained such wording (ordinary
 *  merchant names like "TESCO STORES 3245" or "CAPITAL ONE" pass through
 *  unchanged). Never returns an empty string — falls back to the original
 *  (trimmed) text rather than collapsing to nothing. */
export function normaliseCollectorDisplayName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const m = COLLECTOR_ACTION_PHRASE_RE.exec(trimmed);
  const cleaned = (m ? trimmed.slice(0, m.index) : trimmed).replace(/[.,:;\-–—]+$/, "").trim();
  return cleaned.length >= 2 ? cleaned : trimmed;
}

// ---------------------------------------------------------------------------
// Collector category intelligence (§10) — a small, REUSABLE table of
// pattern-based hints, not one-off hardcoding for a single named collector.
// Deliberately advisory-only: this never assigns a real Category id (that
// remains the existing merchant/category-rules system's job) — it only
// contributes a safe, short, application-owned reason code (e.g.
// "COLLECTOR_CATEGORY_COUNCIL_TAX") that the Review Centre/explainability UI
// can show, matching the same "app-owned reason codes only" discipline the
// AI advisory layer already follows.
// ---------------------------------------------------------------------------
export type CollectorCategoryGroup =
  | "COUNCIL_TAX" | "INSURANCE" | "UTILITIES" | "COMMUNICATIONS" | "SUBSCRIPTION" | "OTHER";

const COLLECTOR_CATEGORY_PATTERNS: Array<{ group: CollectorCategoryGroup; re: RegExp }> = [
  { group: "COUNCIL_TAX", re: /council|borough|city\s+council|c\s*c\b/i },
  { group: "INSURANCE", re: /insur(?:ance|er)?|assurance/i },
  { group: "UTILITIES", re: /electric|gas\b|energy|water|utilit|british\s+gas|octopus|edf|eon\b/i },
  { group: "COMMUNICATIONS", re: /mobile|broadband|telecom|vodafone|\bee\b|three\b|o2\b|sky\b|virgin\s*media|bt\b/i },
  { group: "SUBSCRIPTION", re: /netflix|spotify|prime|subscription|disney|apple\s*(?:music|tv)/i },
];

/** Best-effort, non-authoritative category hint for a normalised collector
 *  name — used only to add an explanatory reason code, never to assign a
 *  real category. Returns null when nothing matches (never guesses "OTHER"
 *  as a positive signal — absence of a hint is not itself information). */
export function collectorCategoryHint(collectorName: string | null | undefined): CollectorCategoryGroup | null {
  if (!collectorName) return null;
  for (const { group, re } of COLLECTOR_CATEGORY_PATTERNS) {
    if (re.test(collectorName)) return group;
  }
  return null;
}

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx]!;
}

/**
 * Robust learned prediction from history. Uses the median for the point estimate
 * and inner percentiles for the range so a single abnormal bill barely moves it.
 */
export function predictedAmount(amounts: number[]): { amountMinor: number; minMinor: number; maxMinor: number } {
  if (amounts.length === 0) return { amountMinor: 0, minMinor: 0, maxMinor: 0 };
  const sorted = [...amounts].sort((a, b) => a - b);
  const point = median(sorted);
  // Inner range: 20th–80th percentile keeps a lone spike/dip out of the band.
  const minMinor = amounts.length >= 4 ? percentile(sorted, 20) : sorted[0]!;
  const maxMinor = amounts.length >= 4 ? percentile(sorted, 80) : sorted[sorted.length - 1]!;
  return { amountMinor: point, minMinor, maxMinor };
}

function mode(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const counts = new Map<number, number>();
  for (const n of nums) counts.set(n, (counts.get(n) ?? 0) + 1);
  let best = nums[0]!;
  let bestC = 0;
  for (const [v, c] of counts) if (c > bestC) { best = v; bestC = c; }
  return best;
}

const DAY = 86_400_000;

function frequencyFromDays(days: number): DdFrequency {
  if (days <= 10) return "WEEKLY";
  if (days <= 18) return "FORTNIGHTLY";
  if (days <= 45) return "MONTHLY";
  if (days <= 135) return "QUARTERLY";
  if (days <= 400) return "YEARLY";
  return "VARIABLE";
}

/** Median interval (in days) between consecutive sorted dates, or null. */
export function medianIntervalDays(datesAsc: Date[]): number | null {
  if (datesAsc.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < datesAsc.length; i++) gaps.push(Math.round((datesAsc[i]!.getTime() - datesAsc[i - 1]!.getTime()) / DAY));
  return median(gaps);
}

function clampDayToMonth(year: number, monthIdx: number, day: number): number {
  const last = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
  return Math.min(day, last);
}

/** Direct Debits generally move off weekends to the next working day. */
function nudgeOffWeekend(d: Date): Date {
  const day = d.getUTCDay();
  if (day === 6) return new Date(d.getTime() + 2 * DAY); // Sat → Mon
  if (day === 0) return new Date(d.getTime() + 1 * DAY); // Sun → Mon
  return d;
}

/**
 * Predict the next payment date from history. Monthly cadences use the typical
 * day-of-month (clamped to month length); other cadences step by their median
 * interval. Weekends nudge forward to the next working day.
 */
export function predictNextDate(datesAsc: Date[], frequency: DdFrequency, dayOfMonth: number | null, from?: Date): Date | null {
  if (datesAsc.length === 0) return null;
  const last = datesAsc[datesAsc.length - 1]!;
  const base = from ?? last;

  if (frequency === "MONTHLY" || frequency === "QUARTERLY" || frequency === "YEARLY") {
    const step = frequency === "MONTHLY" ? 1 : frequency === "QUARTERLY" ? 3 : 12;
    const day = dayOfMonth ?? last.getUTCDate();
    let year = base.getUTCFullYear();
    let monthIdx = base.getUTCMonth() + step;
    year += Math.floor(monthIdx / 12);
    monthIdx = ((monthIdx % 12) + 12) % 12;
    const d = new Date(Date.UTC(year, monthIdx, clampDayToMonth(year, monthIdx, day)));
    return nudgeOffWeekend(d);
  }

  const interval = medianIntervalDays(datesAsc) ?? (frequency === "WEEKLY" ? 7 : frequency === "FORTNIGHTLY" ? 14 : 30);
  return nudgeOffWeekend(new Date(base.getTime() + interval * DAY));
}

// ---- Effective expectation (user override beats learned) -------------------

export interface MandateLike {
  expectationMode: "FIXED" | "RANGE" | "LEARNED";
  expectedAmountMinor: number | null;
  expectedMinMinor: number | null;
  expectedMaxMinor: number | null;
  userExpectedAmountMinor: number | null;
  userExpectedMinMinor: number | null;
  userExpectedMaxMinor: number | null;
  amountTolerancePercent: number;
  amountToleranceMinor: number | null;
  expectedNextDate: Date | null;
  userExpectedDate: Date | null;
  paymentCount: number;
}

export interface EffectiveExpectation {
  point: number | null;
  min: number | null;
  max: number | null;
  toleranceMinor: number;
}

export function effectiveExpectation(m: MandateLike): EffectiveExpectation {
  const point = m.userExpectedAmountMinor ?? m.expectedAmountMinor;
  const min = m.userExpectedMinMinor ?? m.expectedMinMinor;
  const max = m.userExpectedMaxMinor ?? m.expectedMaxMinor;
  const basis = m.expectationMode === "RANGE" ? max ?? point ?? 0 : point ?? max ?? 0;
  const pctTol = Math.round((basis * m.amountTolerancePercent) / 100);
  const toleranceMinor = Math.max(m.amountToleranceMinor ?? 0, pctTol);
  return { point, min, max, toleranceMinor };
}

/** Compare an actual payment to the mandate's expectation. */
export function classifyAnomaly(m: MandateLike, amountMinor: number, date: Date): DdAnomaly {
  if (m.paymentCount === 0) return "FIRST_PAYMENT";
  const e = effectiveExpectation(m);

  let amountVerdict: DdAnomaly = "UNKNOWN";
  if (m.expectationMode === "RANGE" && e.min != null && e.max != null) {
    if (amountMinor > e.max + e.toleranceMinor) amountVerdict = "ABOVE_EXPECTED";
    else if (amountMinor < e.min - e.toleranceMinor) amountVerdict = "BELOW_EXPECTED";
    else amountVerdict = "NORMAL";
  } else if (e.point != null && e.point > 0) {
    if (amountMinor > e.point + e.toleranceMinor) amountVerdict = "ABOVE_EXPECTED";
    else if (amountMinor < e.point - e.toleranceMinor) amountVerdict = "BELOW_EXPECTED";
    else amountVerdict = "NORMAL";
  }

  if (amountVerdict === "NORMAL") {
    // Amount fine — flag a materially different date instead.
    const expectedDate = m.userExpectedDate ?? m.expectedNextDate;
    if (expectedDate) {
      const daysOff = Math.abs(Math.round((date.getTime() - expectedDate.getTime()) / DAY));
      if (daysOff > 5) return "UNEXPECTED_DATE";
    }
  }
  return amountVerdict;
}

export function anomalyMessage(companyName: string, expectedMinor: number, actualMinor: number): string {
  const gbp = (m: number) => `£${(m / 100).toFixed(2)}`;
  const diff = actualMinor - expectedMinor;
  const dir = diff >= 0 ? "higher" : "lower";
  return (
    `${companyName} charged ${gbp(actualMinor)}\n` +
    `Expected approximately ${gbp(expectedMinor)}\n` +
    `${gbp(Math.abs(diff))} ${dir} than expected.`
  );
}

// ---- Orchestration ---------------------------------------------------------

const MANDATE_SELECT = {
  id: true, userId: true, accountId: true, companyName: true, normalizedCompanyName: true,
  status: true, kind: true, frequency: true, expectationMode: true,
  expectedAmountMinor: true, expectedMinMinor: true, expectedMaxMinor: true,
  userExpectedAmountMinor: true, userExpectedMinMinor: true, userExpectedMaxMinor: true,
  userConfiguredExpectedAmount: true, learnFromHistory: true,
  expectedDayOfMonth: true, expectedNextDate: true, userExpectedDate: true,
  amountTolerancePercent: true, amountToleranceMinor: true,
  firstSeenAt: true, lastPaidAt: true, lastAmountMinor: true, nextExpectedAt: true, paymentCount: true,
} satisfies Prisma.DirectDebitMandateSelect;

export interface DetectContext {
  merchant: string | null;
  text: string | null;
  amountMinor: number;
  accountId: string;
  bookedAt: Date;
  direction: string;
  reference?: string | null;
}

/**
 * Detect whether a freshly-created transaction is a Direct Debit, create or match
 * its company mandate, link the transaction and recompute the mandate's learned
 * prediction + this payment's anomaly. Returns the mandate id and anomaly, or null
 * when it is not a Direct Debit. Runs on the supplied transaction client so it can
 * be part of the atomic auto-import.
 */
export async function detectDirectDebit(
  userId: string,
  transactionId: string,
  ctx: DetectContext,
  client: Prisma.TransactionClient = prisma,
): Promise<{ mandateId: string; anomaly: DdAnomaly } | null> {
  if (ctx.direction !== "EXPENSE") return null; // DDs are outgoing
  const company = (ctx.merchant ?? "").trim();
  const normalized = normaliseCompany(company);
  if (!normalized) return null;

  const existing = await client.directDebitMandate.findUnique({
    where: { userId_accountId_normalizedCompanyName: { userId, accountId: ctx.accountId, normalizedCompanyName: normalized } },
    select: MANDATE_SELECT,
  });

  // Only create a NEW company when the text genuinely signals a Direct Debit;
  // otherwise an unrecognised one-off expense should not spawn a mandate.
  if (!existing && !looksLikeDirectDebit(ctx.text) && !looksLikeDirectDebit(ctx.reference)) return null;

  const mandateId = existing
    ? existing.id
    : (
        await client.directDebitMandate.create({
          data: {
            userId,
            accountId: ctx.accountId,
            companyName: company || normalized,
            normalizedCompanyName: normalized,
            mandateReference: ctx.reference ?? undefined,
            kind: "DIRECT_DEBIT",
            status: "ACTIVE",
            firstSeenAt: ctx.bookedAt,
          },
          select: { id: true },
        })
      ).id;

  // Anomaly is judged against the state BEFORE this payment is folded in.
  const before = existing ?? { ...emptyMandateLike(), paymentCount: 0 };
  const anomaly = classifyAnomaly(before as MandateLike, ctx.amountMinor, ctx.bookedAt);

  await client.transaction.update({
    where: { id: transactionId },
    data: {
      transactionType: "DIRECT_DEBIT",
      directDebitMandateId: mandateId,
      recurringKind: "DIRECT_DEBIT",
      recurringConfidence: existing ? 0.95 : 0.8,
      ddAnomaly: anomaly,
    },
  });

  await recomputeMandate(userId, mandateId, client);
  return { mandateId, anomaly };
}

function emptyMandateLike(): MandateLike {
  return {
    expectationMode: "LEARNED", expectedAmountMinor: null, expectedMinMinor: null, expectedMaxMinor: null,
    userExpectedAmountMinor: null, userExpectedMinMinor: null, userExpectedMaxMinor: null,
    amountTolerancePercent: 15, amountToleranceMinor: null, expectedNextDate: null, userExpectedDate: null, paymentCount: 0,
  };
}

/** Recompute learned amount/date/frequency and rolling stats from the mandate's payments. */
export async function recomputeMandate(userId: string, mandateId: string, client: Prisma.TransactionClient = prisma): Promise<void> {
  const mandate = await client.directDebitMandate.findFirst({ where: { id: mandateId, userId }, select: MANDATE_SELECT });
  if (!mandate) return;

  const payments = await client.transaction.findMany({
    where: { userId, directDebitMandateId: mandateId, direction: "EXPENSE", status: { in: ["COMPLETED", "PENDING"] } },
    select: { amountMinor: true, bookedAt: true },
    orderBy: { bookedAt: "asc" },
  });

  const amounts = payments.map((p) => Number(p.amountMinor));
  const dates = payments.map((p) => p.bookedAt);
  const recent = amounts.slice(-12);
  const pred = predictedAmount(recent);
  const interval = medianIntervalDays(dates);
  const frequency = interval ? frequencyFromDays(interval) : mandate.frequency;
  const dayOfMonth = mode(dates.map((d) => d.getUTCDate()));
  const nextExpectedAt = predictNextDate(dates, frequency, dayOfMonth);

  const data: Prisma.DirectDebitMandateUpdateInput = {
    paymentCount: payments.length,
    lastPaidAt: dates.length ? dates[dates.length - 1] : null,
    lastAmountMinor: amounts.length ? amounts[amounts.length - 1] : null,
    frequency,
    expectedDayOfMonth: dayOfMonth ?? undefined,
    nextExpectedAt: mandate.userExpectedDate ?? nextExpectedAt,
  };
  // Only overwrite learned predictions when learning is on and the user hasn't fixed the amount.
  if (mandate.learnFromHistory && !mandate.userConfiguredExpectedAmount) {
    data.expectedAmountMinor = pred.amountMinor;
    data.expectedMinMinor = pred.minMinor;
    data.expectedMaxMinor = pred.maxMinor;
  }
  await client.directDebitMandate.update({ where: { id: mandateId }, data });
}

/** Upcoming Direct Debit payments across a user's active mandates. */
export async function getUpcomingPayments(userId: string, days: number, now = new Date()) {
  const until = new Date(now.getTime() + days * DAY);
  const mandates = await prisma.directDebitMandate.findMany({
    where: { userId, status: { in: ["ACTIVE", "UNKNOWN"] }, nextExpectedAt: { gte: startOfDay(now), lte: until } },
    include: { account: { select: { nickname: true, bankName: true } } },
    orderBy: { nextExpectedAt: "asc" },
  });
  const items = mandates.map((m) => {
    const e = effectiveExpectation(m as unknown as MandateLike);
    return {
      mandateId: m.id,
      // A user-confirmed display alias (§12 — e.g. "MANCHESTER C C" ->
      // "Manchester City Council", set via confirmCollectorAlias()) always
      // wins over the raw notification-derived companyName for display;
      // mandate IDENTITY/matching is untouched (normalizedCompanyName never
      // changes), so this is purely cosmetic.
      companyName: m.merchantAlias ?? m.companyName,
      account: m.account.nickname,
      accountBank: m.account.bankName,
      expectedDate: m.nextExpectedAt?.toISOString() ?? null,
      expectedAmountMinor: e.point ?? m.lastAmountMinor ?? 0,
      isRange: m.expectationMode === "RANGE",
      expectedMinMinor: e.min,
      expectedMaxMinor: e.max,
    };
  });
  const totalMinor = items.reduce((s, i) => s + (i.expectedAmountMinor ?? 0), 0);
  return { items, totalMinor };
}

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ---------------------------------------------------------------------------
// User corrections / learning (§12) — a user-confirmed collector display
// name ("MANCHESTER C C" -> "Manchester City Council") is persisted onto the
// mandate's existing merchantAlias field and always wins over the raw
// notification-derived companyName wherever a mandate is displayed. This is
// display-only: normalizedCompanyName (the mandate's real IDENTITY key used
// for matching/reconciliation) is never touched, so confirming an alias can
// never split or merge a mandate.
//
// Whether a Direct Debit collector IS a credit-card repayment (e.g. "this
// Capital One DD is my credit-card repayment") is a DIFFERENT kind of user
// correction, already handled by the existing, higher-priority
// CounterpartyAccountMapping mechanism (confirmCounterpartyAccount() in
// account-resolution/account-identity-resolver.ts) — resolveOwnedAccount()'s
// Tier 4 (USER_CONFIRMED_MAPPING) is checked before Tier 5 (unique-at-
// institution), so a user-confirmed repayment mapping already takes
// precedence over both deterministic collector-category heuristics and any
// AI advisory input, with no separate mechanism needed here.
// ---------------------------------------------------------------------------

/** Persist a user-confirmed display alias for a mandate. Returns false
 *  (never throws) if the mandate doesn't exist or isn't owned by this user. */
export async function confirmCollectorAlias(
  userId: string,
  mandateId: string,
  alias: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<boolean> {
  const trimmed = alias.trim();
  if (!trimmed) return false;
  const result = await client.directDebitMandate.updateMany({ where: { id: mandateId, userId }, data: { merchantAlias: trimmed } });
  return result.count > 0;
}
