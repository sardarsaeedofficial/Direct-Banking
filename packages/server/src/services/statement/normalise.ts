import { createHash } from "node:crypto";

// Shared helpers + types for the Phase 5 statement parsers. Money is always integer
// minor units; nothing is ever guessed — a row that can't be parsed confidently is
// dropped by the parser (and a whole file that yields no confident rows is rejected).

export type Direction = "INCOME" | "EXPENSE";

export interface ParsedRow {
  rowIndex: number; // 1-based source row/entry number
  bookedAt: Date;
  timeText?: string | null;
  amountMinor: number; // absolute value
  currency: string;
  direction: Direction;
  description: string;
  merchantName?: string | null;
  senderName?: string | null;
  recipientName?: string | null;
  reference?: string | null;
  balanceAfterMinor?: number | null;
}

export interface ParseResult {
  rows: ParsedRow[];
  institution?: string | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
}

/** Thrown when a file (esp. a scanned/opaque PDF) cannot be parsed into rows confidently. */
export class UnsupportedStatementError extends Error {
  constructor(message = "Unsupported statement format") {
    super(message);
    this.name = "UnsupportedStatementError";
  }
}

/**
 * Parse a money string to signed integer minor units. Handles currency symbols,
 * thousands separators, parentheses-negatives, leading +/- and trailing CR/DR
 * markers. Returns null when the value is not a confident number.
 */
export function parseMoneyToMinor(raw: string | number | null | undefined): { minor: number; sign: -1 | 1 } | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;

  let sign: -1 | 1 = 1;
  const upper = s.toUpperCase();
  if (/(^|[^A-Z])(DR|DEBIT)([^A-Z]|$)/.test(upper)) sign = -1;
  else if (/(^|[^A-Z])(CR|CREDIT)([^A-Z]|$)/.test(upper)) sign = 1;
  s = s.replace(/\b(cr|dr|credit|debit)\b/gi, "").trim();

  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    sign = -1;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }

  // Strip currency symbols, spaces and thousands separators (commas).
  s = s.replace(/[£$€,\s]/g, "");
  if (s === "" || !/^\d*\.?\d*$/.test(s) || s === ".") return null;

  const [intPart = "0", fracRaw = ""] = s.split(".");
  const frac = (fracRaw + "00").slice(0, 2);
  const intVal = Number(intPart || "0");
  const fracVal = Number(frac || "0");
  if (!Number.isFinite(intVal) || !Number.isFinite(fracVal)) return null;
  const minor = intVal * 100 + fracVal;
  return { minor, sign };
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

function mkUTC(y: number, m: number, d: number): Date | null {
  if (m < 0 || m > 11 || d < 1 || d > 31) return null;
  const full = y < 100 ? (y >= 70 ? 1900 + y : 2000 + y) : y;
  const dt = new Date(Date.UTC(full, m, d, 0, 0, 0));
  // Reject overflow (e.g. 31 Feb rolling into March).
  if (dt.getUTCFullYear() !== full || dt.getUTCMonth() !== m || dt.getUTCDate() !== d) return null;
  return dt;
}

/**
 * Tolerant date parser. Prefers UK day-first ordering (DD/MM/YYYY) but also accepts
 * ISO (YYYY-MM-DD), OFX compact (YYYYMMDD…), "DD MMM YYYY" and QIF "DD/MM'YY".
 * Returns null when the value is not a confident date.
 */
export function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // OFX compact: YYYYMMDD or YYYYMMDDHHMMSS(.xxx)(tz)
  const ofx = s.match(/^(\d{4})(\d{2})(\d{2})/);
  if (ofx && (s.length === 8 || s.length >= 14 || /^\d{8}(\d|\.|\[)/.test(s))) {
    const d = mkUTC(Number(ofx[1]), Number(ofx[2]) - 1, Number(ofx[3]));
    if (d) return d;
  }

  // ISO YYYY-MM-DD (optional time)
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return mkUTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  // DD MMM YYYY / DD-MMM-YY / MMM DD YYYY
  const named = s.match(/^(\d{1,2})[\s\-]+([A-Za-z]{3,4})[\s\-'"]+(\d{2,4})$/);
  if (named) {
    const m = MONTHS[named[2].toLowerCase()];
    if (m != null) return mkUTC(Number(named[3]), m, Number(named[1]));
  }
  const named2 = s.match(/^([A-Za-z]{3,4})[\s\-]+(\d{1,2})[\s\-,'"]+(\d{2,4})$/);
  if (named2) {
    const m = MONTHS[named2[1].toLowerCase()];
    if (m != null) return mkUTC(Number(named2[3]), m, Number(named2[2]));
  }

  // Numeric with separators: DD/MM/YYYY (day-first). QIF uses ' before the year.
  const num = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-'](\d{2,4})/);
  if (num) {
    const a = Number(num[1]);
    const b = Number(num[2]);
    const y = Number(num[3]);
    // If the first field can't be a day but the second can, it's month-first.
    if (a > 12 && b <= 12) return mkUTC(y, b - 1, a);
    if (b > 12 && a <= 12) return mkUTC(y, a - 1, b); // month-first source
    return mkUTC(y, b - 1, a); // default day-first (UK)
  }
  return null;
}

/** Loose merchant/description cleanup for fingerprinting (not for display). */
export function normaliseDescription(raw: string | null | undefined): string {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A normalized digest of a statement row: date (day), signed amount, direction and
 * a cleaned description/reference. Stable across re-imports of the same statement so
 * duplicate protection and evidence idempotency work — never contains raw file text.
 */
export function rowFingerprint(row: {
  bookedAt: Date;
  amountMinor: number;
  direction: Direction;
  description: string;
  reference?: string | null;
}): string {
  const day = row.bookedAt.toISOString().slice(0, 10);
  const key = [
    day,
    row.direction,
    String(row.amountMinor),
    normaliseDescription(row.description),
    normaliseDescription(row.reference ?? ""),
  ].join("|");
  return createHash("sha1").update(key).digest("hex");
}
