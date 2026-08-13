import { parseDate, parseMoneyToMinor, UnsupportedStatementError, type Direction, type ParsedRow, type ParseResult } from "./normalise.js";

/** RFC4180-ish record splitter: handles quoted fields, escaped quotes, embedded commas/newlines. */
export function parseCsvRecords(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const s = text.replace(/^﻿/, ""); // strip BOM
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // handled by the \n branch; ignore stray CR
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function norm(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function findCol(headers: string[], test: (h: string) => boolean, exclude?: (h: string) => boolean): number {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (exclude && exclude(h)) continue;
    if (test(h)) return i;
  }
  return -1;
}

interface ColMap {
  date: number;
  time: number;
  amount: number;
  debit: number;
  credit: number;
  description: number;
  reference: number;
  currency: number;
  balance: number;
}

function detectColumns(headers: string[]): ColMap | null {
  const h = headers.map(norm);
  const isDebit = (x: string) => /(^|\s)(debit|paid out|money out|withdrawal|withdrawn)(\s|$)/.test(x) || x === "out";
  const isCredit = (x: string) => /(^|\s)(credit|paid in|money in|deposit)(\s|$)/.test(x) || x === "in";

  const debit = findCol(h, isDebit);
  const credit = findCol(h, isCredit);
  // Plain amount column (not the debit/credit ones).
  const amount = findCol(
    h,
    (x) => x === "amount" || x === "value" || /^amount(\s|\().*/.test(x) || /^value(\s|\().*/.test(x) || x === "transaction amount",
    (x) => isDebit(x) || isCredit(x),
  );

  // Date: prefer a "completed"/"transaction"/"posted" date, else any date column.
  let date = findCol(h, (x) => /date/.test(x) && /(complet|transac|post|value)/.test(x));
  if (date < 0) date = findCol(h, (x) => /date/.test(x) && !/start/.test(x));
  if (date < 0) date = findCol(h, (x) => /date/.test(x));

  const time = findCol(h, (x) => x === "time");
  const description = findCol(
    h,
    (x) => /(description|details|narrative|memo|payee|counter party|particulars|name|merchant)/.test(x),
  );
  const reference = findCol(h, (x) => /(reference|^ref$)/.test(x));
  const currency = findCol(h, (x) => x === "currency" || x === "ccy");
  const balance = findCol(h, (x) => /balance/.test(x));

  if (date < 0) return null;
  if (amount < 0 && debit < 0 && credit < 0) return null;
  return { date, time, amount, debit, credit, description, reference, currency, balance };
}

/**
 * Parse a CSV bank statement. Detects the header row and maps common UK/EU bank
 * column layouts (single signed Amount, or separate Debit/Credit / Paid out/Paid
 * in / Money out/Money in). Rows that lack a confident date+amount are skipped.
 */
export function parseCsv(text: string): ParseResult {
  const records = parseCsvRecords(text);
  if (records.length < 2) throw new UnsupportedStatementError();

  // Find the header row within the first few lines (some banks add preamble).
  let headerIdx = -1;
  let cols: ColMap | null = null;
  for (let i = 0; i < Math.min(records.length, 8); i++) {
    const c = detectColumns(records[i]);
    if (c) {
      headerIdx = i;
      cols = c;
      break;
    }
  }
  if (!cols || headerIdx < 0) throw new UnsupportedStatementError();

  const rows: ParsedRow[] = [];
  let minDate: Date | null = null;
  let maxDate: Date | null = null;

  for (let i = headerIdx + 1; i < records.length; i++) {
    const rec = records[i];
    const cell = (idx: number) => (idx >= 0 && idx < rec.length ? rec[idx].trim() : "");

    const bookedAt = parseDate(cell(cols.date));
    if (!bookedAt) continue; // never invent a date

    let minor: number | null = null;
    let direction: Direction | null = null;
    if (cols.amount >= 0 && cell(cols.amount)) {
      const m = parseMoneyToMinor(cell(cols.amount));
      if (m && m.minor > 0) {
        minor = m.minor;
        direction = m.sign < 0 ? "EXPENSE" : "INCOME";
      }
    }
    if (minor == null) {
      const dm = cols.debit >= 0 ? parseMoneyToMinor(cell(cols.debit)) : null;
      const cm = cols.credit >= 0 ? parseMoneyToMinor(cell(cols.credit)) : null;
      if (dm && dm.minor > 0) {
        minor = dm.minor;
        direction = "EXPENSE";
      } else if (cm && cm.minor > 0) {
        minor = cm.minor;
        direction = "INCOME";
      }
    }
    if (minor == null || minor <= 0 || !direction) continue; // no confident amount → skip

    const description = cell(cols.description) || cell(cols.reference) || "Statement transaction";
    const balance = cols.balance >= 0 ? parseMoneyToMinor(cell(cols.balance)) : null;
    const currency = (cols.currency >= 0 && cell(cols.currency)) || "GBP";

    rows.push({
      rowIndex: i + 1,
      bookedAt,
      timeText: cols.time >= 0 ? cell(cols.time) || null : null,
      amountMinor: minor,
      currency: currency.toUpperCase().slice(0, 3),
      direction,
      description,
      reference: cols.reference >= 0 ? cell(cols.reference) || null : null,
      balanceAfterMinor: balance ? balance.minor * balance.sign : null,
    });
    if (!minDate || bookedAt < minDate) minDate = bookedAt;
    if (!maxDate || bookedAt > maxDate) maxDate = bookedAt;
  }

  if (rows.length === 0) throw new UnsupportedStatementError();
  return { rows, periodStart: minDate, periodEnd: maxDate };
}
