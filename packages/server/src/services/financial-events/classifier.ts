import { looksLikeDirectDebit } from "../direct-debit.service.js";

// ---------------------------------------------------------------------------
// NotificationFinancialClassifier — Financial Event Intelligence
//
// The core safety invariant this module exists to enforce:
//
//     Trusted source != completed transaction
//
// A notification arriving from an approved banking app proves WHO sent it.
// It never proves that money has moved, in which direction, or that a
// transaction is finished. This classifier inspects the notification's own
// wording and, whenever that wording clearly indicates the payment has NOT
// completed (upcoming, pending, declined, failed, cancelled, reversed,
// refunded), that finding OVERRIDES whatever direction/confidence the caller
// (e.g. the Android app's own on-device parsing) supplied. Only when the text
// carries no disqualifying signal does the caller's own declared direction
// stand, exactly as it did before this module existed — so ordinary,
// already-correct notifications keep behaving the same way.
//
// Deterministic rules only. No ML/LLM involved — an AI signal must never be
// the sole authority for a ledger mutation (see docs/PHASE6_AUDIT.md's
// financial-integrity principles); this module is priority tiers 1–3 of that
// chain (bank-specific parser -> known semantic phrase rules -> generic
// parser). Tiers 4 (optional future ML suggestion) and 5 (Review when
// uncertain) are represented by the UNKNOWN/LOW-confidence fallthrough below,
// which routes to Review rather than posting.
// ---------------------------------------------------------------------------

export type FinEventKind =
  | "CARD_PURCHASE" | "BANK_TRANSFER" | "DIRECT_DEBIT" | "CREDIT_CARD_REPAYMENT"
  | "STANDING_ORDER" | "SUBSCRIPTION" | "RECURRING_CARD" | "CASH_WITHDRAWAL"
  | "FEE" | "REFUND" | "REVERSAL" | "BALANCE_INFORMATION" | "NON_FINANCIAL" | "UNKNOWN";

export type FinEventLifecycle =
  | "UPCOMING" | "PENDING" | "COMPLETED" | "DECLINED" | "FAILED"
  | "REVERSED" | "CANCELLED" | "REFUNDED" | "UNKNOWN";

export type MoneyEffect = "NONE" | "DEBIT" | "CREDIT";
export type PaymentRail = "DIRECT_DEBIT" | "CARD" | "TRANSFER" | "STANDING_ORDER" | "CASH" | "OTHER";
export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";
export type ClientDirection = "INCOME" | "EXPENSE" | "TRANSFER";

export interface ClassifierInput {
  sourcePackage: string;
  /** true when sourcePackage is a verified/trusted banking app package. Source
   *  trust only — never allowed to force a COMPLETED lifecycle by itself. */
  trustedSource: boolean;
  title: string;
  text: string; // redacted notification body
  merchantHint?: string | null;
  /** The caller's own already-parsed direction/amount (e.g. Android's on-device
   *  classification for the atomic auto-import call). Used only as the
   *  fallback when the text itself carries no disqualifying or confirming
   *  language — it never overrides an explicit decline/future/reversal signal
   *  found in the text. */
  clientDirection?: ClientDirection | null;
  clientAmountMinor?: number | null;
  clientConfidence?: number | null; // 0..1, the client's own confidence
  occurredAt: Date;
}

export interface ClassifierResult {
  isFinancial: boolean;
  eventKind: FinEventKind;
  lifecycle: FinEventLifecycle;
  expectedDirection: ClientDirection | null;
  moneyEffect: MoneyEffect;
  amountMinor: number | null;
  expectedAt: Date | null;
  merchantName: string | null;
  paymentRail: PaymentRail | null;
  confidenceScore: number;
  confidenceLevel: ConfidenceLevel;
  reasonCode: string;
}

// ---- Phrase libraries (§15–17 of the brief) --------------------------------

// Decline/failure/reversal — checked FIRST, and always wins over any
// completion-sounding word elsewhere in the same text (§16, §17: a single
// word like "payment" must never be trusted alone — "payment declined" must
// never register as a completed payment).
const DECLINED_RE = /\b(declined|not authoris(?:ed|ed)|rejected)\b/i;
const FAILED_RE = /\b(payment\s+failed|failed|unsuccessful|couldn'?t\s+complete|could\s+not\s+complete)\b/i;
const REVERSED_RE = /\breversed?\b/i;
const REFUNDED_RE = /\brefunded\b/i;
const CANCELLED_RE = /\bcancell?ed\b/i;
// In-progress-but-not-yet-settled language — a real-time state distinct from
// both "upcoming" (hasn't started) and "completed" (finished). A merchant
// authorisation hold is the same underlying state under a different name.
const PENDING_RE = /\bpending\b|\bauthorisation\s+hold\b|\bawaiting\s+authoris/i;
// Real-time card-authorisation push notifications ("£4.88 on card ending
// 7813. That leaves £202.51 available to spend") are sent the instant a card
// is authorised, before the transaction has posted/settled to the statement
// — typically 1-3 business days for UK card issuers (Capital One's own app
// shows these as "Pending"). Wording-based, not package-gated, so it applies
// to any bank using this phrasing, not only Capital One. Deliberately
// conservative rather than assuming COMPLETED — see §4 of the brief ("do not
// invent certainty"); a later Plaid/Open Banking/statement signal for the
// same amount/account/merchant reconciles it via the existing pending-event
// matching in financial-event.service.ts.
const CARD_AUTH_HOLD_RE = /\bon\s+card\s+ending\b.{0,100}\b(?:that\s+leaves|available\s+to\s+spend|available\s+balance)\b/i;

// Future/upcoming language (§15) — deliberately anchored to phrases that only
// make sense describing something that hasn't happened yet, so ordinary
// prose doesn't accidentally match.
const FUTURE_RE = new RegExp(
  [
    "we'?ll\\s+(?:take|collect)",
    "will\\s+(?:take|leave|be\\s+taken|be\\s+collected)",
    "\\bdue\\s+on\\b",
    "\\bscheduled\\s+for\\b",
    "\\bexpected\\s+on\\b",
    "\\bcoming\\s+out\\b",
    "\\byour\\s+next\\s+payment\\b",
    "\\bupcoming\\s+payment\\b",
    "\\bit\\s+will\\s+be\\b",
  ].join("|"),
  "i",
);
// Weaker future-time markers — only decisive when paired with at least one
// FUTURE_RE phrase above (so "this week" alone, in an otherwise-neutral
// completed-payment notification, doesn't get misread as upcoming).
const FUTURE_TIME_RE = /\b(this\s+week|tomorrow|on\s+[A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?)\b/i;

// Actual-posting language (§17). Deliberately specific — never the single
// generic word "payment", which also appears in "payment due"/"payment
// declined"/"payment expected".
const COMPLETION_RE = new RegExp(
  [
    "you\\s+spent",
    "\\bpaid\\b",
    "payment\\s+made",
    "\\bdebited\\b",
    "has\\s+left\\s+your\\s+account",
    "\\breceived\\b",
    "\\bcredited\\b",
    "paid\\s+in",
    "cash\\s+withdrawal",
    "\\bcompleted\\b",
  ].join("|"),
  "i",
);

const NON_FINANCIAL_RE = new RegExp(
  [
    "statement\\s+is\\s+ready",
    "updated\\s+our\\s+terms",
    "credit\\s+score",
    "card\\s+is\\s+on\\s+its\\s+way",
    "terms\\s+(?:and\\s+conditions|of\\s+service)",
    "new\\s+feature",
    "app\\s+update",
    "welcome\\s+to\\b",
  ].join("|"),
  "i",
);

const CREDIT_CARD_REPAYMENT_RE = new RegExp(
  [
    "monthly\\s+repayment",
    "minimum\\s+payment",
    "statement\\s+balance",
    "we'?ll\\s+(?:take|collect).{0,40}repayment",
    "repayment\\s+from\\s+your\\s+account",
    "\\brepayment\\s+of\\b",
    "credit\\s*card.{0,30}(?:payment|repayment)",
  ].join("|"),
  "i",
);

const STANDING_ORDER_RE = /\bstanding\s+order\b/i;
const SUBSCRIPTION_RE = /\bsubscription\b/i;
const CASH_WITHDRAWAL_RE = /\bcash\s+withdrawal\b/i;
const REFUND_KIND_RE = /\brefund(?:ed)?\b/i;
const FEE_RE = /\b(fee|charge)\b/i;
const BALANCE_INFO_RE = /\byour\s+balance\s+is\b|\bcurrent\s+balance\b/i;

const ACCOUNT_LAST4_RE = /account\s+ending\s+(?:with\s+)?(\d{3,4})/i;
const MONTH_DAY_RE = /on\s+([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?/i;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function hasFutureLanguage(text: string): boolean {
  return FUTURE_RE.test(text) || (FUTURE_TIME_RE.test(text) && /\bwill\b|\bexpected\b|\bleaves\b|\bleaving\b/i.test(text));
}

function detectLifecycleFromText(text: string): { lifecycle: FinEventLifecycle | null; reasonCode: string | null } {
  // Safety-critical order: disqualifying/negative outcomes first, so no
  // completion-sounding word elsewhere can override them.
  if (DECLINED_RE.test(text)) return { lifecycle: "DECLINED", reasonCode: "DECLINE_PHRASE" };
  if (FAILED_RE.test(text)) return { lifecycle: "FAILED", reasonCode: "FAILURE_PHRASE" };
  if (REVERSED_RE.test(text)) return { lifecycle: "REVERSED", reasonCode: "REVERSAL_PHRASE" };
  if (REFUNDED_RE.test(text)) return { lifecycle: "REFUNDED", reasonCode: "REFUND_PHRASE" };
  if (CANCELLED_RE.test(text)) return { lifecycle: "CANCELLED", reasonCode: "CANCEL_PHRASE" };
  if (hasFutureLanguage(text)) return { lifecycle: "UPCOMING", reasonCode: "FUTURE_PHRASE" };
  if (PENDING_RE.test(text)) return { lifecycle: "PENDING", reasonCode: "PENDING_PHRASE" };
  if (CARD_AUTH_HOLD_RE.test(text)) return { lifecycle: "PENDING", reasonCode: "CARD_AUTH_HOLD_PHRASE" };
  return { lifecycle: null, reasonCode: null };
}

// Currency-anchored first: a bare number elsewhere in the text (an account's
// last-4-digits, a reference number) must never be mistaken for the amount —
// only a number actually prefixed by a currency symbol/code counts, with a
// decimal-format bare number as a weaker fallback (account numbers are never
// written with 2 decimal places).
const CURRENCY_AMOUNT_RE = /(?:£|gbp\s*)(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/gi;
const DECIMAL_AMOUNT_RE = /\b(\d{1,3}(?:,\d{3})*\.\d{2})\b/;

// ---------------------------------------------------------------------------
// Multi-amount semantic role extraction. A single notification frequently
// carries more than one monetary value with different meanings ("£4.88 on
// card ending 7813. That leaves £202.51 available to spend") — neither "the
// first amount" nor "the largest amount" is a safe rule for picking the
// transaction amount. Each amount is classified by the wording of its OWN
// sentence (never a neighbouring one, so "Balance £1,000" in a later
// sentence never contaminates an earlier "£80 will leave tomorrow").
// ---------------------------------------------------------------------------

export type AmountRole =
  | "TRANSACTION_AMOUNT" | "AVAILABLE_BALANCE" | "ACCOUNT_BALANCE" | "CREDIT_LIMIT"
  | "EXPECTED_AMOUNT" | "FEE" | "REFUND_AMOUNT" | "UNKNOWN";

export interface AmountCandidate {
  amountMinor: number;
  role: AmountRole;
  raw: string;
}

// A real-time, post-transaction spending-power figure — always contextual,
// never the transaction amount itself.
const AVAILABLE_BALANCE_PHRASE_RE = /\bthat\s+leaves\b|\bavailable\s+to\s+spend\b|\bavailable\s+balance\b|\bavailable\s+credit\b|\bcredit\s+available\b/i;
// A plain account/statement balance figure.
const ACCOUNT_BALANCE_PHRASE_RE = /\bremaining\s+balance\b|\bbalance\s+is\b|\bcurrent\s+balance\b|\bnew\s+balance\b|\bbalance\b/i;
const CREDIT_LIMIT_PHRASE_RE = /\bcredit\s+limit\b/i;
const FEE_PHRASE_RE = /\b(?:admin\s+)?fee\b/i;
const REFUND_PHRASE_RE = /\brefund(?:ed)?\b/i;

// Roles that must NEVER be selected as the transaction amount — a balance,
// limit or fee figure is never posted as a purchase, income, or refund.
const EXCLUDED_AMOUNT_ROLES: ReadonlySet<AmountRole> = new Set(["AVAILABLE_BALANCE", "ACCOUNT_BALANCE", "CREDIT_LIMIT", "FEE"]);

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0);
}

function roleForSentence(sentence: string): AmountRole {
  if (AVAILABLE_BALANCE_PHRASE_RE.test(sentence)) return "AVAILABLE_BALANCE";
  if (ACCOUNT_BALANCE_PHRASE_RE.test(sentence)) return "ACCOUNT_BALANCE";
  if (CREDIT_LIMIT_PHRASE_RE.test(sentence)) return "CREDIT_LIMIT";
  if (FEE_PHRASE_RE.test(sentence)) return "FEE";
  if (REFUND_PHRASE_RE.test(sentence)) return "REFUND_AMOUNT";
  if (hasFutureLanguage(sentence)) return "EXPECTED_AMOUNT";
  return "TRANSACTION_AMOUNT";
}

/** Every currency-anchored amount in [text], tagged with its semantic role.
 *  Never includes a bare (non-currency-prefixed) number — an account's
 *  last-4-digits or a reference number is never a candidate at all. */
export function extractAmountCandidates(text: string): AmountCandidate[] {
  const candidates: AmountCandidate[] = [];
  for (const sentence of splitSentences(text)) {
    const role = roleForSentence(sentence);
    const re = new RegExp(CURRENCY_AMOUNT_RE.source, CURRENCY_AMOUNT_RE.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(sentence))) {
      const cleaned = m[1]!.replace(/,/g, "");
      const value = Math.round(parseFloat(cleaned) * 100);
      if (Number.isFinite(value) && value > 0) candidates.push({ amountMinor: value, role, raw: m[0] });
    }
  }
  return candidates;
}

export function extractAmountMinor(text: string): number | null {
  if (!/£|gbp|paid|spent|payment|charged|debited|repayment|declined|failed/i.test(text)) return null;
  const candidates = extractAmountCandidates(text);
  const selectable = candidates.find((c) => !EXCLUDED_AMOUNT_ROLES.has(c.role));
  if (selectable) return selectable.amountMinor;
  // Currency-anchored amounts exist but every one of them is a balance/limit/
  // fee figure (e.g. a pure balance-summary notification with no transaction
  // amount at all) — never guess one of those as the transaction amount.
  if (candidates.length > 0) return null;
  // No currency-anchored amount anywhere — weaker bare-decimal fallback,
  // unchanged from before this round (account numbers are never written with
  // 2 decimal places, so this stays safe).
  const m = DECIMAL_AMOUNT_RE.exec(text);
  if (!m) return null;
  const cleaned = m[1]!.replace(/,/g, "");
  const value = Math.round(parseFloat(cleaned) * 100);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function extractAccountLast4(text: string): string | null {
  const m = ACCOUNT_LAST4_RE.exec(text);
  return m ? m[1]! : null;
}

/** Extract an explicit merchant/source-account label from free text ("from
 *  your Monzo account", "to MANCHESTER C C"). Falls back to null. */
export function extractMerchant(text: string): string | null {
  // "available to spend"/"available to spend today" is a spending-power
  // idiom, never a merchant/account name — a bare "(?:to|from)" match would
  // otherwise capture "spend" out of it (see the Capital One card-
  // authorisation wording this guards against).
  const toFrom = /(?<!available\s)(?:to|from)\s+(?:your\s+)?([A-Za-z0-9&'. -]{2,40}?)(?:\s+account\b|\s+leaves\b|\s+leaving\b|\s+will\b|,|\.|$)/i.exec(text);
  if (toFrom && toFrom[1]!.trim().toLowerCase() !== "spend") return toFrom[1]!.trim().replace(/[.,]$/, "");
  return null;
}

/** Best-effort expected date from free text: explicit "on <Month> <Day>" wins;
 *  "tomorrow" / "this week" fall back to a reasonable near-term estimate.
 *  Returns null when nothing in the text implies a date at all. */
export function extractExpectedDate(text: string, occurredAt: Date): Date | null {
  const md = MONTH_DAY_RE.exec(text);
  if (md) {
    const monthIdx = MONTHS.indexOf(md[1]!.toLowerCase());
    const day = parseInt(md[2]!, 10);
    if (monthIdx >= 0 && day >= 1 && day <= 31) {
      let year = occurredAt.getUTCFullYear();
      const candidate = new Date(Date.UTC(year, monthIdx, day));
      // If that date has already passed by more than ~2 months relative to the
      // notification, it almost certainly refers to next year, not last year.
      if (candidate.getTime() < occurredAt.getTime() - 60 * 86_400_000) {
        year += 1;
      }
      return new Date(Date.UTC(year, monthIdx, day));
    }
  }
  if (/\btomorrow\b/i.test(text)) return new Date(occurredAt.getTime() + 1 * 86_400_000);
  if (/\bthis\s+week\b/i.test(text)) return new Date(occurredAt.getTime() + 3 * 86_400_000); // midpoint estimate
  return null;
}

function detectEventKind(text: string, isDeclineLike: boolean): { eventKind: FinEventKind; paymentRail: PaymentRail | null } {
  if (CREDIT_CARD_REPAYMENT_RE.test(text)) {
    return { eventKind: "CREDIT_CARD_REPAYMENT", paymentRail: looksLikeDirectDebit(text) ? "DIRECT_DEBIT" : null };
  }
  if (looksLikeDirectDebit(text)) return { eventKind: "DIRECT_DEBIT", paymentRail: "DIRECT_DEBIT" };
  if (STANDING_ORDER_RE.test(text)) return { eventKind: "STANDING_ORDER", paymentRail: "STANDING_ORDER" };
  if (SUBSCRIPTION_RE.test(text)) return { eventKind: "SUBSCRIPTION", paymentRail: "CARD" };
  if (CASH_WITHDRAWAL_RE.test(text)) return { eventKind: "CASH_WITHDRAWAL", paymentRail: "CASH" };
  if (!isDeclineLike && REFUND_KIND_RE.test(text)) return { eventKind: "REFUND", paymentRail: null };
  if (REVERSED_RE.test(text)) return { eventKind: "REVERSAL", paymentRail: null };
  if (BALANCE_INFO_RE.test(text)) return { eventKind: "BALANCE_INFORMATION", paymentRail: null };
  if (FEE_RE.test(text)) return { eventKind: "FEE", paymentRail: null };
  return { eventKind: "UNKNOWN", paymentRail: null };
}

function moneyEffectFor(lifecycle: FinEventLifecycle, direction: ClientDirection | null): MoneyEffect {
  if (lifecycle !== "COMPLETED" && lifecycle !== "REFUNDED" && lifecycle !== "REVERSED") return "NONE";
  if (direction === "INCOME") return "CREDIT";
  if (direction === "EXPENSE") return "DEBIT";
  return "NONE";
}

interface ConfidenceInput {
  lifecycle: FinEventLifecycle;
  reasonCode: string;
  trustedSource: boolean;
  clientConfidence: number | null;
}

/** Confidence policy (§19). Source trust raises confidence; it never by
 *  itself promotes a lifecycle determination to COMPLETED — that promotion
 *  only ever happens in classifyNotification's own lifecycle logic above,
 *  driven by text evidence or the caller's own declared direction. This
 *  function only turns "how was this lifecycle decided" into a score. */
function computeConfidence({ reasonCode, trustedSource, clientConfidence }: ConfidenceInput): { score: number; level: ConfidenceLevel } {
  let score: number;
  if (reasonCode === "CLIENT_DECLARED_NO_DISQUALIFIER") {
    // No disqualifying or confirming language either way — the caller's own
    // (already-parsed, e.g. Android's on-device) confidence is the primary
    // signal here; a verified banking-app package adds a smaller boost. This
    // is the backstop path, not a re-classification of every notification,
    // so a client that already reports high confidence should still reach
    // HIGH — exactly the pre-existing behaviour this module must not regress.
    score = Math.min(0.95, Math.max(0, clientConfidence ?? 0) * 0.85 + (trustedSource ? 0.15 : 0));
  } else if (reasonCode === "NO_SIGNAL") {
    // Neither text evidence nor a client-declared direction at all.
    score = trustedSource ? 0.35 : 0.15;
  } else {
    // An explicit phrase matched in the notification's own text — future,
    // decline, failure, cancellation, reversal, refund, or completion
    // language. Strong, source-trust-independent evidence: the wording
    // itself is the authority, not which app sent it.
    score = trustedSource ? 0.85 : 0.8;
  }
  score = Math.min(1, Math.round(score * 100) / 100);
  const level: ConfidenceLevel = score >= 0.75 ? "HIGH" : score >= 0.5 ? "MEDIUM" : "LOW";
  return { score, level };
}

/**
 * Classify a single notification into a financial event descriptor. Pure
 * function, deterministic, no I/O — safe to unit-test exhaustively and safe
 * to call from any pipeline (mobile auto-import, web review queue, future
 * batch re-evaluation).
 */
export function classifyNotification(input: ClassifierInput): ClassifierResult {
  const text = `${input.title} ${input.text}`.trim();
  const merchant = input.merchantHint ?? extractMerchant(text) ?? (input.title || null);

  if (NON_FINANCIAL_RE.test(text) && !DECLINED_RE.test(text) && !FAILED_RE.test(text) && !hasFutureLanguage(text) && !COMPLETION_RE.test(text) && !looksLikeDirectDebit(text)) {
    return {
      isFinancial: false,
      eventKind: "NON_FINANCIAL",
      lifecycle: "UNKNOWN",
      expectedDirection: null,
      moneyEffect: "NONE",
      amountMinor: null,
      expectedAt: null,
      merchantName: merchant,
      paymentRail: null,
      confidenceScore: input.trustedSource ? 0.9 : 0.6,
      confidenceLevel: input.trustedSource ? "HIGH" : "MEDIUM",
      reasonCode: "NON_FINANCIAL_PHRASE",
    };
  }

  const { lifecycle: semanticLifecycle, reasonCode: lifecycleReason } = detectLifecycleFromText(text);
  const isDeclineLike = semanticLifecycle === "DECLINED" || semanticLifecycle === "FAILED" || semanticLifecycle === "CANCELLED";
  const { eventKind, paymentRail } = detectEventKind(text, isDeclineLike);

  let lifecycle: FinEventLifecycle;
  let reasonCode: string;
  if (semanticLifecycle) {
    lifecycle = semanticLifecycle;
    reasonCode = lifecycleReason!;
  } else if (COMPLETION_RE.test(text)) {
    lifecycle = "COMPLETED";
    reasonCode = "COMPLETION_PHRASE";
  } else if (input.clientDirection && (input.clientConfidence ?? 0) >= 0.6) {
    // No disqualifying or confirming language in the text — this is the
    // backstop, not a re-classification of every legitimate notification.
    lifecycle = "COMPLETED";
    reasonCode = "CLIENT_DECLARED_NO_DISQUALIFIER";
  } else {
    lifecycle = "UNKNOWN";
    reasonCode = "NO_SIGNAL";
  }

  const expectedDirection = input.clientDirection ?? (eventKind === "BANK_TRANSFER" ? "TRANSFER" : null);
  const moneyEffect = moneyEffectFor(lifecycle, expectedDirection);
  const amountMinor = input.clientAmountMinor ?? extractAmountMinor(text);
  const expectedAt = lifecycle === "UPCOMING" ? extractExpectedDate(text, input.occurredAt) : null;
  const confidence = computeConfidence({ lifecycle, reasonCode, trustedSource: input.trustedSource, clientConfidence: input.clientConfidence ?? null });

  return {
    isFinancial: true,
    // A concrete lifecycle (something is known to have happened, be about to
    // happen, or have failed/been declined) with no more specific kind
    // detected defaults to the most common shape (a card purchase / bank
    // transfer) rather than staying UNKNOWN — UNKNOWN is reserved for when
    // the lifecycle itself is unresolved (routed to Review below).
    eventKind: eventKind === "UNKNOWN" && lifecycle !== "UNKNOWN"
      ? (expectedDirection === "TRANSFER" ? "BANK_TRANSFER" : "CARD_PURCHASE")
      : eventKind,
    lifecycle,
    expectedDirection,
    moneyEffect,
    amountMinor,
    expectedAt,
    merchantName: merchant,
    paymentRail,
    confidenceScore: confidence.score,
    confidenceLevel: confidence.level,
    reasonCode,
  };
}
