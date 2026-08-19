import { describe, expect, it } from "vitest";
import { extractAmountCandidates, extractAmountMinor, classifyNotification } from "./classifier.js";

// Pure-function unit tests for the classifier's multi-amount semantic role
// extraction (Capital One notification-parser round, §3/§14) and the
// card-authorisation-hold PENDING classification it enables (§4). No DB, no
// HTTP — these are the FIRST dedicated unit tests for classifier.ts (all
// prior coverage went through financial-event-intelligence.test.ts's
// integration fixtures, which always supply clientAmountMinor directly and
// so never actually exercise extractAmountMinor()'s own fallback logic).

describe("extractAmountCandidates / extractAmountMinor — multi-amount semantic roles", () => {
  it("Capital One: transaction amount before 'that leaves ... available to spend' is selected, never the balance figure", () => {
    const text = "£4.88 on card ending 7813. That leaves £202.51 available to spend";
    const candidates = extractAmountCandidates(text);
    expect(candidates.map((c) => c.amountMinor)).toEqual([488, 20251]);
    expect(candidates[0]!.role).toBe("TRANSACTION_AMOUNT");
    expect(candidates[1]!.role).toBe("AVAILABLE_BALANCE");
    expect(extractAmountMinor(text)).toBe(488);
  });

  it("a second Capital One notification with a different amount is extracted independently", () => {
    const text = "£1.74 on card ending 7813. That leaves £202.51 available to spend";
    expect(extractAmountMinor(text)).toBe(174);
  });

  it("'Spent £10.00. Balance £245.20' selects the spend, not the balance", () => {
    const candidates = extractAmountCandidates("Spent £10.00. Balance £245.20");
    expect(candidates[0]).toMatchObject({ amountMinor: 1000, role: "TRANSACTION_AMOUNT" });
    expect(candidates[1]).toMatchObject({ amountMinor: 24520, role: "ACCOUNT_BALANCE" });
    expect(extractAmountMinor("Spent £10.00. Balance £245.20")).toBe(1000);
  });

  it("'£25 payment declined. Available balance £500' selects the declined amount, not the balance", () => {
    const text = "£25 payment declined. Available balance £500";
    const candidates = extractAmountCandidates(text);
    expect(candidates[0]).toMatchObject({ amountMinor: 2500, role: "TRANSACTION_AMOUNT" });
    expect(candidates[1]).toMatchObject({ amountMinor: 50000, role: "AVAILABLE_BALANCE" });
    expect(extractAmountMinor(text)).toBe(2500);
  });

  it("'Direct debit of £80 will leave tomorrow. Balance £1,000' selects the £80, never the £1,000 balance", () => {
    const text = "Direct debit of £80 will leave tomorrow. Balance £1,000";
    const candidates = extractAmountCandidates(text);
    expect(candidates[0]).toMatchObject({ amountMinor: 8000, role: "EXPECTED_AMOUNT" });
    expect(candidates[1]).toMatchObject({ amountMinor: 100000, role: "ACCOUNT_BALANCE" });
    expect(extractAmountMinor(text)).toBe(8000);
  });

  it("'Received £500. New balance £1,200' selects the income amount, never the new balance", () => {
    const text = "Received £500. New balance £1,200";
    const candidates = extractAmountCandidates(text);
    expect(candidates[0]).toMatchObject({ amountMinor: 50000, role: "TRANSACTION_AMOUNT" });
    expect(candidates[1]).toMatchObject({ amountMinor: 120000, role: "ACCOUNT_BALANCE" });
    expect(extractAmountMinor(text)).toBe(50000);
  });

  it("a refund amount is tagged REFUND_AMOUNT and is still selectable", () => {
    const candidates = extractAmountCandidates("£4.88 refunded to card ending 7813");
    expect(candidates[0]).toMatchObject({ amountMinor: 488, role: "REFUND_AMOUNT" });
    expect(extractAmountMinor("£4.88 refunded to card ending 7813")).toBe(488);
  });

  it("a credit limit figure is never selected as the transaction amount", () => {
    // No genuine transaction amount here at all — every currency figure is a
    // limit/balance, so extractAmountMinor must return null, never guess one.
    expect(extractAmountMinor("Your credit limit is £2,000. Current balance £430.00")).toBeNull();
  });

  it("falls back to a bare decimal only when no currency-anchored amount exists at all", () => {
    expect(extractAmountMinor("Payment of 12.50 processed")).toBe(1250);
  });

  it("never mistakes a card/account last-4 for an amount", () => {
    expect(extractAmountMinor("card ending 7813")).toBeNull();
  });
});

describe("classifyNotification — Capital One card-authorisation-hold wording", () => {
  const base = {
    sourcePackage: "com.ie.capitalone.uk",
    trustedSource: true,
    occurredAt: new Date("2026-08-15T10:00:00Z"),
  };

  it("'£4.88 on card ending 7813. That leaves £202.51 available to spend' classifies PENDING, not COMPLETED", () => {
    const r = classifyNotification({
      ...base,
      title: "ALIEXPRESS.COM",
      text: "£4.88 on card ending 7813. That leaves £202.51 available to spend",
    });
    expect(r.isFinancial).toBe(true);
    expect(r.lifecycle).toBe("PENDING");
    expect(r.reasonCode).toBe("CARD_AUTH_HOLD_PHRASE");
    expect(r.amountMinor).toBe(488);
    expect(r.moneyEffect).toBe("NONE"); // never a booked-balance mutation while pending
    expect(r.merchantName).toBe("ALIEXPRESS.COM");
  });

  it("never classifies the card-authorisation wording as Income", () => {
    const r = classifyNotification({
      ...base,
      title: "ALIEXPRESS.COM",
      text: "£4.88 on card ending 7813. That leaves £202.51 available to spend",
    });
    expect(r.lifecycle).not.toBe("UNKNOWN");
    // PENDING has no expectedDirection forced onto it here (no client-declared
    // direction supplied in this fixture) — moneyEffect NONE either way, so it
    // can never be mistaken for a credit/income event.
    expect(r.moneyEffect).not.toBe("CREDIT");
  });

  it("the same wording from an UNTRUSTED source still classifies PENDING (wording, not package trust, decides lifecycle)", () => {
    const r = classifyNotification({
      sourcePackage: "com.some.unrelated.app",
      trustedSource: false,
      occurredAt: base.occurredAt,
      title: "ALIEXPRESS.COM",
      text: "£4.88 on card ending 7813. That leaves £202.51 available to spend",
    });
    expect(r.lifecycle).toBe("PENDING");
  });

  it("a trusted Capital One package cannot force COMPLETED over explicit decline wording", () => {
    const r = classifyNotification({
      ...base,
      title: "ALIEXPRESS.COM",
      text: "Your £4.88 payment on card ending 7813 was declined",
      clientDirection: "EXPENSE",
      clientAmountMinor: 488,
      clientConfidence: 0.95,
    });
    expect(r.lifecycle).toBe("DECLINED");
    expect(r.moneyEffect).toBe("NONE");
  });

  it("a trusted Capital One package cannot force COMPLETED over refund wording", () => {
    const r = classifyNotification({
      ...base,
      title: "ALIEXPRESS.COM",
      text: "£4.88 refunded to card ending 7813",
    });
    expect(r.lifecycle).toBe("REFUNDED");
    expect(r.amountMinor).toBe(488);
  });

  it("does not misfire the pending/auth-hold classification for unrelated 'balance' notifications", () => {
    const r = classifyNotification({
      ...base,
      title: "Capital One",
      text: "Your current balance is £430.00",
    });
    expect(r.lifecycle).not.toBe("PENDING");
  });
});

// Final release completion (§7): explicit regression fixtures pinned to the
// EXACT real-world wording named in the release checklist, run at the
// classifier unit level (no DB) so they can never be skipped by an
// unreachable test database. financial-event-intelligence.test.ts already
// covers the full Halifax/Zable/Capital One end-to-end flows (mandate
// creation, ledger posting, spending exclusion) with semantically
// equivalent but differently-worded fixtures — these pin the literal
// phrasing given in this round so a regex too narrowly tailored to the
// earlier wording would fail here first.
describe("Final release completion — pinned real-world notification wording", () => {
  it("Halifax: 'Direct Debit leaves this week. Estimated £170.00' -> UPCOMING DIRECT_DEBIT, never an immediate deduction", () => {
    const r = classifyNotification({
      sourcePackage: "unknown.halifax",
      trustedSource: false,
      occurredAt: new Date("2026-08-15T10:00:00Z"),
      title: "Halifax",
      text: "Direct Debit leaves this week. Estimated £170.00",
    });
    expect(r.lifecycle).toBe("UPCOMING");
    expect(r.eventKind).toBe("DIRECT_DEBIT");
    expect(r.moneyEffect).toBe("NONE");
    expect(r.amountMinor).toBe(17000);
  });

  it("Zable: 'Your monthly repayment of £254.43 will be taken on a future date' -> UPCOMING CREDIT_CARD_REPAYMENT, never Income, never an immediate balance change", () => {
    const r = classifyNotification({
      sourcePackage: "unknown.zable",
      trustedSource: false,
      occurredAt: new Date("2026-08-15T10:00:00Z"),
      title: "Zable",
      text: "Your monthly repayment of £254.43 will be taken on a future date",
    });
    expect(r.lifecycle).toBe("UPCOMING");
    expect(r.eventKind).toBe("CREDIT_CARD_REPAYMENT");
    expect(r.expectedDirection).not.toBe("INCOME");
    expect(r.moneyEffect).toBe("NONE");
    expect(r.amountMinor).toBe(25443);
  });

  it("a normal completed card purchase classifies COMPLETED/CARD_PURCHASE/DEBIT — the ordinary, non-edge-case path", () => {
    const r = classifyNotification({
      sourcePackage: "com.monzo.android",
      trustedSource: true,
      occurredAt: new Date("2026-08-15T10:00:00Z"),
      title: "Tesco",
      text: "You spent £23.50 at Tesco",
      clientDirection: "EXPENSE",
      clientAmountMinor: 2350,
      clientConfidence: 0.95,
    });
    expect(r.lifecycle).toBe("COMPLETED");
    expect(r.eventKind).toBe("CARD_PURCHASE");
    expect(r.expectedDirection).toBe("EXPENSE");
    expect(r.moneyEffect).toBe("DEBIT");
    expect(r.amountMinor).toBe(2350);
  });

  it("normal incoming income classifies COMPLETED/CREDIT, never a purchase", () => {
    const r = classifyNotification({
      sourcePackage: "com.monzo.android",
      trustedSource: true,
      occurredAt: new Date("2026-08-15T10:00:00Z"),
      title: "Acme Payroll Ltd",
      text: "You were paid £1,850.00 by Acme Payroll Ltd",
      clientDirection: "INCOME",
      clientAmountMinor: 185000,
      clientConfidence: 0.95,
    });
    expect(r.lifecycle).toBe("COMPLETED");
    expect(r.expectedDirection).toBe("INCOME");
    expect(r.moneyEffect).toBe("CREDIT");
    expect(r.amountMinor).toBe(185000);
  });
});
