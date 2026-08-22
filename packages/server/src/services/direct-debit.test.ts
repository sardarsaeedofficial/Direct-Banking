import { describe, expect, it } from "vitest";
import {
  normaliseCompany,
  looksLikeDirectDebit,
  predictedAmount,
  predictNextDate,
  classifyAnomaly,
  effectiveExpectation,
  medianIntervalDays,
  normaliseCollectorDisplayName,
  collectorCategoryHint,
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

describe("normaliseCollectorDisplayName — §3 collector/merchant normalisation", () => {
  it("strips a trailing 'Leaves Your' fragment from a truncated on-device merchant guess", () => {
    expect(normaliseCollectorDisplayName("Manchester C C Leaves Your")).toBe("Manchester C C");
  });
  it("strips 'leaves your account ending NNNN this week' down to the collector name", () => {
    expect(normaliseCollectorDisplayName("MANCHESTER C C leaves your account ending 7164 this week")).toBe("MANCHESTER C C");
  });
  it("strips 'will leave' wording", () => {
    expect(normaliseCollectorDisplayName("Manchester City Council will leave your account")).toBe("Manchester City Council");
  });
  it("strips 'is due to leave' wording", () => {
    expect(normaliseCollectorDisplayName("Capital One is due to leave your account")).toBe("Capital One");
  });
  it("leaves an ordinary clean collector name unchanged (safe no-op)", () => {
    expect(normaliseCollectorDisplayName("CAPITAL ONE")).toBe("CAPITAL ONE");
    expect(normaliseCollectorDisplayName("Zable Card")).toBe("Zable Card");
    expect(normaliseCollectorDisplayName("TESCO STORES 3245")).toBe("TESCO STORES 3245");
  });
  it("never collapses to an empty string — falls back to the original text", () => {
    expect(normaliseCollectorDisplayName("Leaves")).toBe("Leaves");
  });
  it("handles null/empty input safely", () => {
    expect(normaliseCollectorDisplayName(null)).toBeNull();
    expect(normaliseCollectorDisplayName("")).toBeNull();
    expect(normaliseCollectorDisplayName("   ")).toBeNull();
  });
});

describe("collectorCategoryHint — §10 reusable collector category intelligence", () => {
  it("recognises a council/local-authority collector", () => {
    expect(collectorCategoryHint("Manchester City Council")).toBe("COUNCIL_TAX");
    expect(collectorCategoryHint("MANCHESTER C C")).toBe("COUNCIL_TAX");
  });
  it("recognises an insurance collector", () => {
    expect(collectorCategoryHint("Admiral Insurance")).toBe("INSURANCE");
  });
  it("recognises a utility collector", () => {
    expect(collectorCategoryHint("British Gas")).toBe("UTILITIES");
    expect(collectorCategoryHint("Octopus Energy")).toBe("UTILITIES");
  });
  it("recognises a communications collector", () => {
    expect(collectorCategoryHint("Vodafone")).toBe("COMMUNICATIONS");
  });
  it("recognises a well-known subscription collector", () => {
    expect(collectorCategoryHint("Netflix")).toBe("SUBSCRIPTION");
  });
  it("returns null for an unrecognised collector — never guesses", () => {
    expect(collectorCategoryHint("Zable Card")).toBeNull();
    expect(collectorCategoryHint(null)).toBeNull();
  });
});
