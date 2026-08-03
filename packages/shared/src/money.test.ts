import { describe, expect, it } from "vitest";
import { toMinor, toMajor, formatMoney } from "./money.js";

describe("money", () => {
  it("parses major-unit strings to pence", () => {
    expect(toMinor("85")).toBe(8500);
    expect(toMinor("85.50")).toBe(8550);
    expect(toMinor("1,234.5")).toBe(123450);
    expect(toMinor("£85.00")).toBe(8500);
    expect(toMinor("-12.34")).toBe(-1234);
  });

  it("rejects nonsense", () => {
    expect(() => toMinor("abc")).toThrow();
    expect(() => toMinor("1.2.3")).toThrow();
  });

  it("round-trips through major units", () => {
    expect(toMajor(8500)).toBe(85);
    expect(toMajor(8550n)).toBe(85.5);
  });

  it("formats GBP by default", () => {
    expect(formatMoney(8500)).toBe("£85.00");
    expect(formatMoney(123450n)).toBe("£1,234.50");
  });
});
