import { describe, expect, it } from "vitest";

// Own process — see registry-provider-selection.test.ts's header comment.

describe("getClassifier — provider=claude but no API key (own process)", () => {
  it("falls back to the null classifier, never throws, deterministic engine unaffected", async () => {
    process.env.TRANSACTION_AI_ENABLED = "true";
    process.env.TRANSACTION_AI_PROVIDER = "claude";
    delete process.env.TRANSACTION_AI_API_KEY;
    process.env.MOBILE_JWT_SECRET ||= "test-mobile-secret-0123456789abcdef";
    process.env.SESSION_SECRET ||= "test-session-secret-0123456789abcdef";
    process.env.DATABASE_URL ||= "postgresql://user:pass@localhost:5432/test";

    const { getClassifier, getTransactionAiReadiness } = await import("./registry.js");
    const { NullSemanticClassifier } = await import("./null-classifier.js");
    expect(getClassifier()).toBeInstanceOf(NullSemanticClassifier);
    const readiness = getTransactionAiReadiness();
    expect(readiness.reason).toBe("NOT_CONFIGURED");
    expect(readiness.missing).toContain("TRANSACTION_AI_API_KEY");
  });
});
