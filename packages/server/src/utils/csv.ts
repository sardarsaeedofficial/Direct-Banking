/** Minimal RFC-4180 CSV parser (handles quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, ""); // strip BOM

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch === "\r") {
      // ignore; newline handled on \n
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Parse a date string given an explicit ordering. Returns null if invalid. */
export function parseDate(value: string, order: "DMY" | "MDY" | "YMD"): Date | null {
  const v = value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}/.exec(v);
  if (iso && order === "YMD") return new Date(`${v.slice(0, 10)}T00:00:00Z`);
  const parts = v.split(/[\/\-.]/).map((p) => parseInt(p, 10));
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  let day: number, month: number, year: number;
  if (order === "DMY") [day, month, year] = [parts[0]!, parts[1]!, parts[2]!];
  else if (order === "MDY") [month, day, year] = [parts[0]!, parts[1]!, parts[2]!];
  else [year, month, day] = [parts[0]!, parts[1]!, parts[2]!];
  if (year < 100) year += 2000;
  const d = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(d.getTime()) ? null : d;
}
