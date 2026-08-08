import { describe, expect, it } from "vitest";
import {
  normaliseCompany,
  looksLikeDirectDebit,
  predictedAmount,
  predictNextDate,
  classifyAnomaly,
  effectiveExpectation,
  medianIntervalDays,
} from "./direct-debit.service.js";

describe("normaliseCompany", () => {
  it("folds harmless company-name variants together", () => {
    const key = normaliseCompany("British Gas");
    expect(normaliseCompany("BRITISH GAS")).toBe(key);
    expect(normaliseCompany("BRITISH GAS SERVICES")).toBe(key);
    expect(normaliseCompany("BritishGas")).toBe(key);
    expect(normaliseCompany("British Gas Ltd")).toBe(key);
  });
  it("does not merge unrelated companies", () => {
    expect(normaliseCompany("British Airways")).not.toBe(normaliseCompany("British Gas"));
    expect(normaliseCompany("Netflix")).not.toBe(normaliseCompany("Spotify"));
  });
});

describe("looksLikeDirectDebit", () => {
  it("detects direct-debit wording", () => {
    expect(looksLikeDirectDebit("British Gas Direct Debit £82")).toBe(true);
    expect(looksLikeDirectDebit("DD to Vodafone")).toBe(true);
    expect(looksLikeDirectDebit("You spent £5 at Tesco")).toBe(false);
  });
});

describe("predictedAmount", () => {
  it("uses the median and a robust inner range", () => {
    const r = predictedAmount([8200, 7900, 8100, 7600]);
    expect(r.amountMinor).toBe(8000); // median of the four
  });
  it("keeps a single abnormal bill out of the range", () => {
    const r = predictedAmount([8200, 7900, 8100, 7600, 12500]);
    expect(r.amountMinor).toBe(8100); // median unaffected by the spike
    expect(r.maxMinor).toBeLessThan(12500); // spike excluded from the band
  });
});

describe("predictNextDate", () => {
  it("predicts the next month around the same day", () => {
    const dates = [new Date(Date.UTC(2025, 4, 15)), new Date(Date.UTC(2025, 5, 16)), new Date(Date.UTC(2025, 6, 15))];
    const next = predictNextDate(dates, "MONTHLY", 15)!;
    expect(next.getUTCMonth()).toBe(7); // August
    expect(next.getUTCDate()).toBeGreaterThanOrEqual(15); // ~15th (may nudge off a weekend)
    expect(next.getUTCDate()).toBeLessThanOrEqual(17);
  });
  it("computes the median interval for non-monthly cadences", () => {
    const dates = [new Date(Date.UTC(2025, 0, 1)), new Date(Date.UTC(2025, 0, 8)), new Date(Date.UTC(2025, 0, 15))];
    expect(medianIntervalDays(dates)).toBe(7);
  });
});

// A minimal mandate shape for anomaly tests.
const mandate = (over: Partial<Parameters<typeof effectiveExpectation>[0]> = {}) => ({
  expectationMode: "LEARNED" as const,
  expectedAmountMinor: 8000,
  expectedMinMinor: 7000,
  expectedMaxMinor: 10000,
  userExpectedAmountMinor: null,
  userExpectedMinMinor: null,
  userExpectedMaxMinor: null,
  amountTolerancePercent: 10,
  amountToleranceMinor: null,
  expectedNextDate: null,
  userExpectedDate: null,
  paymentCount: 3,
  ...over,
});

describe("classifyAnomaly", () => {
  it("flags the first payment", () => {
    expect(classifyAnomaly(mandate({ paymentCount: 0 }), 3400, new Date())).toBe("FIRST_PAYMENT");
  });
  it("treats an expected amount as normal", () => {
    expect(classifyAnomaly(mandate({ expectationMode: "FIXED", expectedAmountMinor: 3400 }), 3400, new Date())).toBe("NORMAL");
  });
  it("flags a materially higher amount", () => {
    expect(classifyAnomaly(mandate({ expectationMode: "FIXED", expectedAmountMinor: 8000 }), 12500, new Date())).toBe("ABOVE_EXPECTED");
  });
  it("treats a value inside a configured range as normal", () => {
    const m = mandate({ expectationMode: "RANGE", expectedMinMinor: 7000, expectedMaxMinor: 10000, amountTolerancePercent: 0 });
    expect(classifyAnomaly(m, 9000, new Date())).toBe("NORMAL");
  });
  it("flags a value above a configured range", () => {
    const m = mandate({ expectationMode: "RANGE", expectedMinMinor: 7000, expectedMaxMinor: 10000, amountTolerancePercent: 0 });
    expect(classifyAnomaly(m, 12000, new Date())).toBe("ABOVE_EXPECTED");
  });
});

describe("effectiveExpectation", () => {
  it("prefers the user override over the learned value", () => {
    const e = effectiveExpectation(mandate({ expectedAmountMinor: 8000, userExpectedAmountMinor: 3400 }));
    expect(e.point).toBe(3400);
  });
});
