import { parseDate, parseMoneyToMinor, UnsupportedStatementError, type Direction, type ParsedRow, type ParseResult } from "./normalise.js";

/**
 * Parse a QIF (Quicken Interchange Format) statement. Entries are separated by a
 * lone "^"; within an entry: D=date, T/U=amount, P=payee, M=memo, N=number/ref,
 * L=category. Amount sign gives direction. Rejects files with no dated amounts.
 */
export function parseQif(text: string): ParseResult {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (!lines.some((l) => l.startsWith("!Type") || /^\^/.test(l) || /^D/.test(l))) {
    throw new UnsupportedStatementError();
  }

  const rows: ParsedRow[] = [];
  let minDate: Date | null = null;
  let maxDate: Date | null = null;
  let cur: { date?: Date | null; amount?: { minor: number; sign: -1 | 1 } | null; payee?: string; memo?: string; ref?: string } = {};
  let entryIndex = 0;

  const flush = () => {
    if (cur.date && cur.amount && cur.amount.minor > 0) {
      entryIndex++;
      const direction: Direction = cur.amount.sign < 0 ? "EXPENSE" : "INCOME";
      const description = cur.payee || cur.memo || "Statement transaction";
      rows.push({
        rowIndex: entryIndex,
        bookedAt: cur.date,
        amountMinor: cur.amount.minor,
        currency: "GBP",
        direction,
        description,
        reference: cur.ref || cur.memo || null,
      });
      if (!minDate || cur.date < minDate) minDate = cur.date;
      if (!maxDate || cur.date > maxDate) maxDate = cur.date;
    }
    cur = {};
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("!")) continue; // header (!Type:Bank)
    if (line === "^") {
      flush();
      continue;
    }
    if (!line) continue;
    const code = line[0];
    const val = line.slice(1).trim();
    switch (code) {
      case "D":
        cur.date = parseDate(val);
        break;
      case "T":
      case "U":
        cur.amount = parseMoneyToMinor(val);
        break;
      case "P":
        cur.payee = val;
        break;
      case "M":
        cur.memo = val;
        break;
      case "N":
        cur.ref = val;
        break;
      default:
        break;
    }
  }
  flush(); // final entry may not be terminated with ^

  if (rows.length === 0) throw new UnsupportedStatementError();
  return { rows, periodStart: minDate, periodEnd: maxDate };
}
