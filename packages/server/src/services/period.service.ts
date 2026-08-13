// Timezone-aware reporting periods (Phase 4). Transactions are stored in UTC; only
// the *boundaries* of reporting periods are computed in the user's IANA timezone so a
// "month" lines up with the user's local calendar, not UTC. No third-party TZ library
// is used — offsets come from Intl.DateTimeFormat, which ships with Node.

export type PeriodKind = "week" | "month" | "year" | "custom";

export interface DateRange {
  start: Date; // inclusive (UTC instant)
  end: Date; // exclusive (UTC instant)
}

/** Minutes the timezone is ahead of UTC at the given instant (e.g. +60 for BST). */
function tzOffsetMinutes(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const asUTC = Date.UTC(+map.year!, +map.month! - 1, +map.day!, +map.hour!, +map.minute!, +map.second!);
  return (asUTC - date.getTime()) / 60000;
}

/** Local calendar parts (Y/M/D + weekday) of an instant in a timezone. */
export function zonedParts(date: Date, tz: string): { year: number; month: number; day: number; weekday: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { year: +map.year!, month: +map.month!, day: +map.day!, weekday: weekdayMap[map.weekday!] ?? 0 };
}

/** UTC instant of local wall-clock midnight (start of day) for a Y/M/D in a timezone. */
export function zonedStartOfDayUtc(year: number, month: number, day: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  // Correct the guess by the timezone offset at that instant. Using the offset at the
  // guessed instant is exact except within the (rare) DST-transition hour at midnight;
  // month/week boundaries in practice never land in that window.
  const offset = tzOffsetMinutes(new Date(guess), tz);
  return new Date(guess - offset * 60000);
}

/** The calendar month (local) containing `ref`. */
export function monthRange(tz: string, ref: Date = new Date()): DateRange {
  const { year, month } = zonedParts(ref, tz);
  const start = zonedStartOfDayUtc(year, month, 1, tz);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const end = zonedStartOfDayUtc(nextYear, nextMonth, 1, tz);
  return { start, end };
}

/** The calendar month before the one containing `ref`. */
export function prevMonthRange(tz: string, ref: Date = new Date()): DateRange {
  const { year, month } = zonedParts(ref, tz);
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const start = zonedStartOfDayUtc(prevYear, prevMonth, 1, tz);
  const end = zonedStartOfDayUtc(year, month, 1, tz);
  return { start, end };
}

/** The local calendar year containing `ref`. */
export function yearRange(tz: string, ref: Date = new Date()): DateRange {
  const { year } = zonedParts(ref, tz);
  return { start: zonedStartOfDayUtc(year, 1, 1, tz), end: zonedStartOfDayUtc(year + 1, 1, 1, tz) };
}

/** The local calendar year before the one containing `ref`. */
export function prevYearRange(tz: string, ref: Date = new Date()): DateRange {
  const { year } = zonedParts(ref, tz);
  return { start: zonedStartOfDayUtc(year - 1, 1, 1, tz), end: zonedStartOfDayUtc(year, 1, 1, tz) };
}

/** The local week (Monday-start) containing `ref`. */
export function weekRange(tz: string, ref: Date = new Date()): DateRange {
  const { year, month, day, weekday } = zonedParts(ref, tz);
  const daysSinceMonday = (weekday + 6) % 7; // Mon=0 … Sun=6
  const startDay = zonedStartOfDayUtc(year, month, day, tz);
  const start = new Date(startDay.getTime() - daysSinceMonday * 86400000);
  const end = new Date(start.getTime() + 7 * 86400000);
  return { start, end };
}

/** Resolve a period kind to a concrete UTC range. `custom` requires both bounds. */
export function rangeForPeriod(
  kind: PeriodKind,
  tz: string,
  opts: { ref?: Date; customStart?: Date; customEnd?: Date } = {},
): DateRange {
  const ref = opts.ref ?? new Date();
  switch (kind) {
    case "week": return weekRange(tz, ref);
    case "year": return yearRange(tz, ref);
    case "custom":
      if (!opts.customStart || !opts.customEnd) throw new Error("custom period requires start and end");
      return { start: opts.customStart, end: opts.customEnd };
    case "month":
    default: return monthRange(tz, ref);
  }
}

/** Stable "YYYY-MM" key for the local month of `ref` — used to de-duplicate budget
 *  alerts within a period. */
export function monthPeriodKey(tz: string, ref: Date = new Date()): string {
  const { year, month } = zonedParts(ref, tz);
  return `${year}-${String(month).padStart(2, "0")}`;
}
