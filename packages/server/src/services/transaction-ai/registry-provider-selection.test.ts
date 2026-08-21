import { describe, expect, it } from "vitest";

// getClassifier()'s real env-driven provider resolution — own file/process
// (see registry.test.ts's note). Each `it` sets env vars BEFORE its own
// fresh dynamic import so env.ts (parsed once and frozen per process) picks
// them up; every scenario here needs its own process, achieved by never
// statically importing registry.js at this file's top level.

describe("getClassifier — real env-driven provider resolution (own process)", () => {
  it("provider=claude + API key present resolves to a real ClaudeSemanticClassifier instance (never calls it)", async () => {
    process.env.TRANSACTION_AI_ENABLED = "true";
    process.env.TRANSACTION_AI_PROVIDER = "claude";
    process.env.TRANSACTION_AI_API_KEY = "sk-test-not-real";
    process.env.MOBILE_JWT_SECRET ||= "test-mobile-secret-0123456789abcdef";
    process.env.SESSION_SECRET ||= "test-session-secret-0123456789abcdef";
    process.env.DATABASE_URL ||= "postgresql://user:pass@localhost:5432/test";

    const { getClassifier } = await import("./registry.js");
    const { ClaudeSemanticClassifier } = await import("./claude-classifier.js");
    const classifier = getClassifier();
    expect(classifier).toBeInstanceOf(ClaudeSemanticClassifier);
    expect(classifier.name).toBe("claude");
  });
});
