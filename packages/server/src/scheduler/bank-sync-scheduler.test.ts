import { describe, expect, it } from "vitest";
import { cronMatches } from "./bank-sync-scheduler.js";

describe("cronMatches", () => {
  it("matches a daily time", () => {
    expect(cronMatches("0 9 * * *", new Date(2026, 0, 1, 9, 0))).toBe(true);
    expect(cronMatches("0 9 * * *", new Date(2026, 0, 1, 9, 1))).toBe(false);
    expect(cronMatches("0 9 * * *", new Date(2026, 0, 1, 10, 0))).toBe(false);
  });

  it("supports step and list fields", () => {
    expect(cronMatches("*/15 * * * *", new Date(2026, 0, 1, 8, 30))).toBe(true);
    expect(cronMatches("*/15 * * * *", new Date(2026, 0, 1, 8, 31))).toBe(false);
    expect(cronMatches("0 9,17 * * *", new Date(2026, 0, 1, 17, 0))).toBe(true);
  });

  it("applies standard day-of-month / day-of-week OR semantics", () => {
    // Monday-only (2026-01-05 is a Monday).
    expect(cronMatches("0 9 * * 1", new Date(2026, 0, 5, 9, 0))).toBe(true);
    expect(cronMatches("0 9 * * 1", new Date(2026, 0, 6, 9, 0))).toBe(false); // Tuesday
    // dom restricted only.
    expect(cronMatches("0 9 15 * *", new Date(2026, 0, 15, 9, 0))).toBe(true);
    expect(cronMatches("0 9 15 * *", new Date(2026, 0, 16, 9, 0))).toBe(false);
  });

  it("rejects malformed expressions", () => {
    expect(cronMatches("bad", new Date())).toBe(false);
    expect(cronMatches("* * *", new Date())).toBe(false);
  });
});
