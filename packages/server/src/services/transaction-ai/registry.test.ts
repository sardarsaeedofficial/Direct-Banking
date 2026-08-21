import { afterEach, describe, expect, it } from "vitest";
import { getClassifier, setClassifierForTests, transactionAiEnabled } from "./registry.js";
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
