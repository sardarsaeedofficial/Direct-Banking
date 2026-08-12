import { describe, expect, it } from "vitest";
import {
  monthRange, prevMonthRange, yearRange, prevYearRange, weekRange, monthPeriodKey, zonedParts,
} from "./period.service.js";

describe("period.service (timezone-aware boundaries)", () => {
  it("computes a UTC month range aligned to the local calendar month", () => {
    const r = monthRange("UTC", new Date("2026-05-15T12:00:00Z"));
    expect(r.start.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("respects the user's timezone at a month boundary", () => {
    // 2026-05-01 05:00 UTC is still 2026-04-30 22:00 in Los Angeles (PDT, UTC-7),
    // so the month is April there, not May.
    const ref = new Date("2026-05-01T05:00:00Z");
    expect(zonedParts(ref, "America/Los_Angeles").month).toBe(4);
    const r = monthRange("America/Los_Angeles", ref);
    expect(r.start.toISOString()).toBe("2026-04-01T07:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-05-01T07:00:00.000Z");
    expect(monthPeriodKey("America/Los_Angeles", ref)).toBe("2026-04");
  });

  it("gives a stable YYYY-MM period key", () => {
    expect(monthPeriodKey("UTC", new Date("2026-01-09T00:00:00Z"))).toBe("2026-01");
    expect(monthPeriodKey("UTC", new Date("2026-12-31T23:00:00Z"))).toBe("2026-12");
  });

  it("computes the previous month, wrapping the year", () => {
    const r = prevMonthRange("UTC", new Date("2026-01-15T00:00:00Z"));
    expect(r.start.toISOString()).toBe("2025-12-01T00:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("computes calendar-year ranges", () => {
    const cur = yearRange("UTC", new Date("2026-07-01T00:00:00Z"));
    expect(cur.start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(cur.end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    const prev = prevYearRange("UTC", new Date("2026-07-01T00:00:00Z"));
    expect(prev.start.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(prev.end.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("starts weeks on Monday", () => {
    // 2026-05-13 is a Wednesday → week starts Monday 2026-05-11.
    const r = weekRange("UTC", new Date("2026-05-13T09:00:00Z"));
    expect(r.start.toISOString()).toBe("2026-05-11T00:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-05-18T00:00:00.000Z");
  });
});
