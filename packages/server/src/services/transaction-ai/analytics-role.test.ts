import { describe, expect, it } from "vitest";
import { analyticsRoleFor } from "./analytics-role.js";

describe("analyticsRoleFor", () => {
  it("a completed card purchase is SPENDING", () => {
    const r = analyticsRoleFor({ eventKind: "CARD_PURCHASE", expectedDirection: "EXPENSE", lifecycle: "COMPLETED" });
    expect(r.role).toBe("SPENDING");
  });

  it("completed income is INCOME", () => {
    const r = analyticsRoleFor({ eventKind: "BANK_TRANSFER", expectedDirection: "INCOME", lifecycle: "COMPLETED" });
    expect(r.role).toBe("INCOME");
  });

  it("a credit-card repayment is LIABILITY_REPAYMENT, never SPENDING", () => {
    const r = analyticsRoleFor({ eventKind: "CREDIT_CARD_REPAYMENT", expectedDirection: "EXPENSE", lifecycle: "COMPLETED" });
    expect(r.role).toBe("LIABILITY_REPAYMENT");
    expect(r.role).not.toBe("SPENDING");
  });

  it("a confirmed internal transfer is INTERNAL_TRANSFER regardless of raw direction", () => {
    const r = analyticsRoleFor({ eventKind: "BANK_TRANSFER", expectedDirection: "INCOME", lifecycle: "COMPLETED", isConfirmedInternalTransfer: true });
    expect(r.role).toBe("INTERNAL_TRANSFER");
  });

  it("an internal-transfer candidate (not yet confirmed) is REVIEW, never locked as INCOME", () => {
    const r = analyticsRoleFor({ eventKind: "BANK_TRANSFER", expectedDirection: "INCOME", lifecycle: "COMPLETED", isInternalTransferCandidate: true });
    expect(r.role).toBe("REVIEW");
    expect(r.role).not.toBe("INCOME");
  });

  it("UPCOMING is IGNORE — no money has moved", () => {
    expect(analyticsRoleFor({ eventKind: "CREDIT_CARD_REPAYMENT", expectedDirection: "EXPENSE", lifecycle: "UPCOMING" }).role).toBe("IGNORE");
  });

  it("DECLINED is IGNORE", () => {
    expect(analyticsRoleFor({ eventKind: "CARD_PURCHASE", expectedDirection: "EXPENSE", lifecycle: "DECLINED" }).role).toBe("IGNORE");
  });

  it("REFUNDED lifecycle is REFUND", () => {
    expect(analyticsRoleFor({ eventKind: "CARD_PURCHASE", expectedDirection: "INCOME", lifecycle: "REFUNDED" }).role).toBe("REFUND");
  });

  it("a REFUND eventKind is REFUND even if lifecycle is plain COMPLETED", () => {
    expect(analyticsRoleFor({ eventKind: "REFUND", expectedDirection: "INCOME", lifecycle: "COMPLETED" }).role).toBe("REFUND");
  });

  it("balance-information notifications are IGNORE, never counted", () => {
    expect(analyticsRoleFor({ eventKind: "BALANCE_INFORMATION", expectedDirection: null, lifecycle: "COMPLETED" }).role).toBe("IGNORE");
  });

  it("no direction and no other signal is REVIEW, never guessed", () => {
    expect(analyticsRoleFor({ eventKind: "UNKNOWN", expectedDirection: null, lifecycle: "COMPLETED" }).role).toBe("REVIEW");
  });

  it("a confirmed internal transfer takes priority even over CREDIT_CARD_REPAYMENT eventKind", () => {
    const r = analyticsRoleFor({ eventKind: "CREDIT_CARD_REPAYMENT", expectedDirection: "EXPENSE", lifecycle: "COMPLETED", isConfirmedInternalTransfer: true });
    expect(r.role).toBe("INTERNAL_TRANSFER");
  });
});
