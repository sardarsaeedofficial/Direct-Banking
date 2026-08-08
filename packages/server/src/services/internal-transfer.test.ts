import { describe, expect, it } from "vitest";
import { normaliseName, nameSimilarity, scorePair, isAutoInternal, type TransferSide } from "./internal-transfer.service.js";

describe("normaliseName", () => {
  it("upper-cases, strips titles and punctuation", () => {
    expect(normaliseName("Mr. Sardar Saeed")).toBe("SARDAR SAEED");
    expect(normaliseName("SARDAR   SAEED")).toBe("SARDAR SAEED");
    expect(normaliseName(null)).toBe("");
  });
});

describe("nameSimilarity", () => {
  it("treats casing and spacing variants as identical", () => {
    expect(nameSimilarity("Sardar Saeed", "SARDAR SAEED")).toBe(1);
  });
  it("accepts initials and extra middle names as strong (not perfect) matches", () => {
    expect(nameSimilarity("Sardar Saeed", "S Saeed")).toBeGreaterThanOrEqual(0.85);
    expect(nameSimilarity("Sardar M Saeed", "Sardar Saeed")).toBeGreaterThanOrEqual(0.85);
  });
  it("returns 0 for different surnames", () => {
    expect(nameSimilarity("Sardar Saeed", "Sardar Khan")).toBe(0);
    expect(nameSimilarity("Alice Smith", "Bob Jones")).toBe(0);
  });
});

const base: Omit<TransferSide, "direction" | "accountId"> = {
  amountMinor: 10000n,
  currency: "GBP",
  bookedAt: new Date("2026-08-08T10:00:00Z"),
};

describe("scorePair", () => {
  it("auto-classifies two own accounts, equal & opposite, close in time", () => {
    const a: TransferSide = { ...base, accountId: "monzo", direction: "EXPENSE" };
    const b: TransferSide = { ...base, accountId: "revolut", direction: "INCOME" };
    const r = scorePair(a, b);
    expect(isAutoInternal(r.confidence)).toBe(true); // HIGH or CONFIRMED
  });

  it("reaches CONFIRMED when holder names also match", () => {
    const a: TransferSide = { ...base, accountId: "monzo", direction: "EXPENSE", accountHolderName: "Sardar Saeed", counterpartyName: "Sardar Saeed" };
    const b: TransferSide = { ...base, accountId: "revolut", direction: "INCOME", accountHolderName: "Sardar Saeed", counterpartyName: "Sardar Saeed" };
    expect(scorePair(a, b).confidence).toBe("CONFIRMED");
  });

  it("does NOT pair transactions in the same direction", () => {
    const a: TransferSide = { ...base, accountId: "monzo", direction: "EXPENSE" };
    const b: TransferSide = { ...base, accountId: "revolut", direction: "EXPENSE" };
    expect(scorePair(a, b).confidence).toBe("NOT_INTERNAL");
  });

  it("does NOT pair different amounts", () => {
    const a: TransferSide = { ...base, accountId: "monzo", direction: "EXPENSE", amountMinor: 10000n };
    const b: TransferSide = { ...base, accountId: "revolut", direction: "INCOME", amountMinor: 9900n };
    expect(scorePair(a, b).confidence).toBe("NOT_INTERNAL");
  });

  it("does not auto-classify same-amount opposite transactions days apart on name alone", () => {
    const a: TransferSide = { ...base, accountId: "monzo", direction: "EXPENSE", counterpartyName: "Sardar Saeed", bookedAt: new Date("2026-08-01T10:00:00Z") };
    const b: TransferSide = { ...base, accountId: "revolut", direction: "INCOME", counterpartyName: "Sardar Saeed", bookedAt: new Date("2026-08-08T10:00:00Z") };
    // >24h apart: only base(0.3) + name(0.3) = 0.6 → POSSIBLE, never auto.
    expect(isAutoInternal(scorePair(a, b).confidence)).toBe(false);
  });

  it("weights account-id evidence above name matching", () => {
    const a: TransferSide = { ...base, accountId: "monzo", direction: "EXPENSE", counterpartyAccountId: "revolut", bookedAt: new Date("2026-08-05T10:00:00Z") };
    const b: TransferSide = { ...base, accountId: "revolut", direction: "INCOME", bookedAt: new Date("2026-08-08T10:00:00Z") };
    // 3 days apart (timing 0) but hard account-id evidence: 0.3 + 0.4 = 0.7 → auto.
    expect(isAutoInternal(scorePair(a, b).confidence)).toBe(true);
  });
});
