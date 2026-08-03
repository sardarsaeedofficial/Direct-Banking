import { describe, expect, it } from "vitest";
import { nextOccurrence } from "./expected-payments.service.js";

const base = { dayOfMonth: 20 as number | null, intervalDays: null as number | null };

describe("nextOccurrence", () => {
  it("advances monthly on the given day of month", () => {
    const from = new Date(Date.UTC(2026, 0, 20, 9, 0, 0)); // 20 Jan 2026
    const next = nextOccurrence(from, { ...base, frequency: "MONTHLY" });
    expect(next.getUTCMonth()).toBe(1); // February
    expect(next.getUTCDate()).toBe(20);
  });

  it("clamps day 31 to the last day of a short month", () => {
    const from = new Date(Date.UTC(2026, 0, 31, 9, 0, 0)); // 31 Jan
    const next = nextOccurrence(from, { dayOfMonth: 31, intervalDays: null, frequency: "MONTHLY" });
    expect(next.getUTCMonth()).toBe(1); // February
    expect(next.getUTCDate()).toBe(28); // 2026 is not a leap year
  });

  it("advances weekly by 7 days", () => {
    const from = new Date(Date.UTC(2026, 5, 1));
    const next = nextOccurrence(from, { dayOfMonth: null, intervalDays: null, frequency: "WEEKLY" });
    expect(Math.round((next.getTime() - from.getTime()) / 86_400_000)).toBe(7);
  });

  it("honours a custom interval", () => {
    const from = new Date(Date.UTC(2026, 5, 1));
    const next = nextOccurrence(from, { dayOfMonth: null, intervalDays: 10, frequency: "CUSTOM" });
    expect(Math.round((next.getTime() - from.getTime()) / 86_400_000)).toBe(10);
  });

  it("rolls a year forward for annual", () => {
    const from = new Date(Date.UTC(2026, 2, 15));
    const next = nextOccurrence(from, { dayOfMonth: 15, intervalDays: null, frequency: "ANNUAL" });
    expect(next.getUTCFullYear()).toBe(2027);
    expect(next.getUTCMonth()).toBe(2);
  });
});
