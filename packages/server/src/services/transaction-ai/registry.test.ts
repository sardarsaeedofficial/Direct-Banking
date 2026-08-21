import { afterEach, describe, expect, it } from "vitest";
import { getClassifier, setClassifierForTests, transactionAiEnabled, computeTransactionAiReadiness } from "./registry.js";
import { NullSemanticClassifier } from "./null-classifier.js";
import { FakeSemanticClassifier } from "./fake-classifier.js";

describe("transaction-ai registry", () => {
  afterEach(() => setClassifierForTests(null));

  it("reports disabled by default (TRANSACTION_AI_ENABLED defaults to false)", () => {
    expect(transactionAiEnabled()).toBe(false);
  });

  it("returns the null classifier when nothing is configured", () => {
    const c = getClassifier();
    expect(c).toBeInstanceOf(NullSemanticClassifier);
    expect(c.name).toBe("null");
  });

  it("setClassifierForTests overrides the resolved classifier", () => {
    const fake = new FakeSemanticClassifier();
    setClassifierForTests(fake);
    expect(getClassifier()).toBe(fake);
  });

  it("setClassifierForTests(null) resets back to the default", () => {
    setClassifierForTests(new FakeSemanticClassifier());
    setClassifierForTests(null);
    expect(getClassifier()).toBeInstanceOf(NullSemanticClassifier);
  });
});

describe("computeTransactionAiReadiness — provider selection & missing config", () => {
  it("disabled -> DISABLED regardless of provider/config", () => {
    const r = computeTransactionAiReadiness({ enabled: false, provider: "claude", apiKey: "sk-test" });
    expect(r.reason).toBe("DISABLED");
    expect(r.enabled).toBe(false);
  });

  it("enabled + no provider named -> NOT_CONFIGURED, never silently assumes one", () => {
    const r = computeTransactionAiReadiness({ enabled: true });
    expect(r.reason).toBe("NOT_CONFIGURED");
    expect(r.missing).toContain("TRANSACTION_AI_PROVIDER");
  });

  it("enabled + unrecognised provider -> NOT_CONFIGURED, not a guess", () => {
    const r = computeTransactionAiReadiness({ enabled: true, provider: "openai" });
    expect(r.reason).toBe("NOT_CONFIGURED");
    expect(r.provider).toBe("openai"); // reported as-is for diagnostics, never silently coerced to "claude"
  });

  it("enabled + provider=claude + missing API key -> NOT_CONFIGURED (AI unavailable, deterministic engine continues)", () => {
    const r = computeTransactionAiReadiness({ enabled: true, provider: "claude" });
    expect(r.reason).toBe("NOT_CONFIGURED");
    expect(r.missing).toEqual(["TRANSACTION_AI_API_KEY"]);
  });

  it("enabled + provider=claude + API key present -> READY", () => {
    const r = computeTransactionAiReadiness({ enabled: true, provider: "claude", apiKey: "sk-test" });
    expect(r.reason).toBe("READY");
    expect(r.missing).toEqual([]);
  });

  it("defaults the reported model to claude-opus-5 when TRANSACTION_AI_MODEL is unset", () => {
    const r = computeTransactionAiReadiness({ enabled: true, provider: "claude", apiKey: "sk-test" });
    expect(r.model).toBe("claude-opus-5");
  });

  it("never echoes back the API key — only whether it is present", () => {
    const r = computeTransactionAiReadiness({ enabled: true, provider: "claude", apiKey: "sk-super-secret-value" });
    expect(JSON.stringify(r)).not.toContain("sk-super-secret-value");
  });
});

// getClassifier()'s actual env-driven wiring (as opposed to the pure
// computeTransactionAiReadiness() decision logic above) is exercised
// end-to-end in registry-provider-selection.test.ts — its own file/process,
// since env.ts's parsed config is frozen at first import within a process
// and this file's own top-level imports already trigger that exactly once.
