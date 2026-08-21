import { describe, expect, it, vi } from "vitest";
import { ClaudeSemanticClassifier, type MessagesClient } from "./claude-classifier.js";
import type { ClassifierInput } from "./types.js";

// ClaudeSemanticClassifier tests — NEVER make a real billable API call. The
// adapter's constructor accepts any object satisfying MessagesClient, so
// these inject a fake with a mocked `messages.create` instead of the real
// Anthropic SDK client or any HTTP mocking library.

const input: ClassifierInput = {
  sourceInstitution: "Zable",
  sourcePackage: "unknown.zable",
  title: "Zable",
  sanitizedText: "Payment to Zable Card has left your account",
  amountMinor: 25443,
  currency: "GBP",
  direction: "EXPENSE",
  accountHint: null,
  candidateOwnedAccounts: [{ accountId: "acc-zable", label: "Zable Credit Card", accountType: "CREDIT_CARD" }],
  knownMerchant: "Zable Card",
  deterministicClassification: { eventKind: "CARD_PURCHASE", paymentRail: null, confidenceLevel: "LOW" },
};

function toolUseResponse(toolInput: unknown) {
  return {
    id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5",
    content: [{ type: "tool_use", id: "tu_1", name: "classify_transaction", input: toolInput }],
    stop_reason: "tool_use", stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  } as never;
}

const validOutput = {
  eventKind: "CREDIT_CARD_REPAYMENT",
  paymentRail: "DIRECT_DEBIT",
  analyticsRole: "LIABILITY_REPAYMENT",
  sourceAccountCandidate: null,
  destinationAccountCandidate: "Zable Credit Card",
  merchantNormalized: "Zable",
  isLikelyInternalTransfer: false,
  isLikelyCreditCardRepayment: true,
  isLikelyDirectDebit: true,
  confidence: 0.92,
  reasons: ["Payee matches a known owned credit card"],
};

describe("ClaudeSemanticClassifier", () => {
  it("classifies via a forced tool call and validates the structured output", async () => {
    const create = vi.fn().mockResolvedValue(toolUseResponse(validOutput));
    const fakeClient: MessagesClient = { messages: { create } };
    const classifier = new ClaudeSemanticClassifier(fakeClient, "claude-opus-5");

    const result = await classifier.classify(input);
    expect(result).toEqual(validOutput);
    expect(create).toHaveBeenCalledTimes(1);
    const call = create.mock.calls[0][0];
    expect(call.model).toBe("claude-opus-5");
    expect(call.tool_choice).toEqual({ type: "tool", name: "classify_transaction" });
    expect(call.tools[0].strict).toBe(true);
  });

  it("sends a request-level timeout under the advisory layer's own 4s race", async () => {
    const create = vi.fn().mockResolvedValue(toolUseResponse(validOutput));
    const fakeClient: MessagesClient = { messages: { create } };
    const classifier = new ClaudeSemanticClassifier(fakeClient, "claude-opus-5");
    await classifier.classify(input);
    const options = create.mock.calls[0][1];
    expect(options.timeout).toBeLessThan(4000);
  });

  it("discards a schema-invalid tool response — never partially trusted", async () => {
    const create = vi.fn().mockResolvedValue(toolUseResponse({ eventKind: "NOT_REAL", confidence: "high" }));
    const fakeClient: MessagesClient = { messages: { create } };
    const classifier = new ClaudeSemanticClassifier(fakeClient, "claude-opus-5");
    expect(await classifier.classify(input)).toBeNull();
  });

  it("returns null when the response has no tool_use block at all", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "msg_2", type: "message", role: "assistant", model: "claude-opus-5",
      content: [{ type: "text", text: "I cannot classify this." }],
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 },
    });
    const fakeClient: MessagesClient = { messages: { create } };
    const classifier = new ClaudeSemanticClassifier(fakeClient, "claude-opus-5");
    expect(await classifier.classify(input)).toBeNull();
  });

  it("propagates an HTTP/provider error to the caller (advisory.ts is the layer that swallows it)", async () => {
    const create = vi.fn().mockRejectedValue(Object.assign(new Error("rate limited"), { status: 429 }));
    const fakeClient: MessagesClient = { messages: { create } };
    const classifier = new ClaudeSemanticClassifier(fakeClient, "claude-opus-5");
    await expect(classifier.classify(input)).rejects.toThrow();
  });

  it("never sends a forbidden field even if the input object is widened unexpectedly", async () => {
    const create = vi.fn().mockResolvedValue(toolUseResponse(validOutput));
    const fakeClient: MessagesClient = { messages: { create } };
    const classifier = new ClaudeSemanticClassifier(fakeClient, "claude-opus-5");
    const poisoned = { ...input, accessToken: "secret-token-value" } as unknown as ClassifierInput;
    await expect(classifier.classify(poisoned)).rejects.toThrow(/forbidden field/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("the prompt sent to the provider never contains the raw redacted-away card/account number pattern", async () => {
    const create = vi.fn().mockResolvedValue(toolUseResponse(validOutput));
    const fakeClient: MessagesClient = { messages: { create } };
    const classifier = new ClaudeSemanticClassifier(fakeClient, "claude-opus-5");
    await classifier.classify({ ...input, sanitizedText: "Card [card-number-redacted] charged" });
    const call = create.mock.calls[0][0];
    const promptText = JSON.stringify(call.messages);
    expect(promptText).not.toMatch(/\d{13,19}/); // no run of digits long enough to be a real card/account number
    expect(promptText).toContain("[card-number-redacted]");
  });
});
