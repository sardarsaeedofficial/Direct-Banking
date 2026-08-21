import Anthropic from "@anthropic-ai/sdk";
import { assertNoForbiddenFields } from "./redaction.js";
import {
  analyticsRoleValues,
  finEventKindValues,
  parseClassifierOutput,
  paymentRailValues,
  type ClassifierInput,
  type ClassifierOutput,
  type TransactionSemanticClassifier,
} from "./types.js";

// ---------------------------------------------------------------------------
// ClaudeSemanticClassifier — the ONE concrete TransactionSemanticClassifier
// adapter (Transaction AI Provider round). Talks to the Claude API via the
// official @anthropic-ai/sdk only — no other module in this codebase imports
// it, so swapping/removing this provider never touches business logic (see
// registry.ts, the only caller that constructs this class).
//
// Structured output strategy: a forced tool call (tool_choice: {type:
// "tool", name: ...}) with `strict: true`, so the SDK itself validates the
// JSON shape before we ever see it — and the result is THEN independently
// re-validated against classifierOutputSchema (the same Zod schema every
// other classifier's output goes through) before advisory.ts trusts a single
// field. No free-form prose is ever read as authoritative — only the one
// tool_use block's structured `input`.
// ---------------------------------------------------------------------------

const TOOL_NAME = "classify_transaction";
// Slightly under advisory.ts's own 4s outer race, so a hung HTTP request is
// aborted by the SDK itself (and its cost accrual stopped) rather than only
// abandoned by the caller while the request keeps running in the background.
const REQUEST_TIMEOUT_MS = 3_500;
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT = [
  "You classify a single already-anonymised UK banking notification for a personal finance app.",
  "You are ADVISORY ONLY: your output can never move money, change a lifecycle, change an amount/currency, delete anything, or decide which account owns a transaction — a separate deterministic system does all of that and may discard your answer entirely.",
  "You will be given already-redacted, minimal evidence — never a full account/card number, never a token, never a password. Do not ask for more information; classify from what is given, and use low confidence when evidence is genuinely thin.",
  "Call the classify_transaction tool exactly once with your best structured classification. Do not include any other commentary.",
].join(" ");

function buildTool(): Anthropic.Tool {
  return {
    name: TOOL_NAME,
    description: "Record a structured classification of the notification's economic purpose. This is the ONLY way to respond.",
    input_schema: {
      type: "object",
      properties: {
        eventKind: { type: "string", enum: [...finEventKindValues], description: "The notification's economic kind." },
        paymentRail: { type: ["string", "null"], enum: [...paymentRailValues, null], description: "How the payment moves, if known." },
        analyticsRole: { type: "string", enum: [...analyticsRoleValues], description: "How this should count in analytics." },
        sourceAccountCandidate: { type: ["string", "null"], description: "Label of the candidate source account, ONLY if it exactly matches one of the candidateOwnedAccounts labels given to you — otherwise null. Never invent a label." },
        destinationAccountCandidate: { type: ["string", "null"], description: "Label of the candidate destination account, ONLY if it exactly matches one of the candidateOwnedAccounts labels given to you — otherwise null. Never invent a label." },
        merchantNormalized: { type: ["string", "null"], description: "A cleaned-up merchant/payee name, or null." },
        isLikelyInternalTransfer: { type: "boolean" },
        isLikelyCreditCardRepayment: { type: "boolean" },
        isLikelyDirectDebit: { type: "boolean" },
        confidence: { type: "number", minimum: 0, maximum: 1, description: "Your genuine confidence, 0 (guessing) to 1 (certain)." },
        reasons: { type: "array", items: { type: "string", maxLength: 140 }, maxItems: 6, description: "Short, plain, factual reasons — never chain-of-thought, never speculation about the user." },
      },
      required: [
        "eventKind", "paymentRail", "analyticsRole", "sourceAccountCandidate", "destinationAccountCandidate",
        "merchantNormalized", "isLikelyInternalTransfer", "isLikelyCreditCardRepayment", "isLikelyDirectDebit",
        "confidence", "reasons",
      ],
      additionalProperties: false,
    },
    strict: true,
  };
}

/** Minimal, already-redacted, structured evidence only — see redaction.ts
 *  for what was stripped before this input was ever constructed upstream
 *  (financial-event.service.ts). Defensively re-checked here so this
 *  adapter can never forward a forbidden field even if a future caller
 *  widens ClassifierInput without updating that check. */
function buildUserPrompt(input: ClassifierInput): string {
  assertNoForbiddenFields(input as unknown as Record<string, unknown>);
  const lines: string[] = [
    `Source institution: ${input.sourceInstitution ?? "unknown"}`,
    `Notification title: ${input.title}`,
    `Notification text: ${input.sanitizedText}`,
    `Amount (minor units): ${input.amountMinor ?? "unknown"}`,
    `Currency: ${input.currency}`,
    `Direction: ${input.direction ?? "unknown"}`,
  ];
  if (input.accountHint) lines.push(`Account hint (last digits only): ${input.accountHint}`);
  if (input.knownMerchant) lines.push(`Known merchant label: ${input.knownMerchant}`);
  if (input.candidateOwnedAccounts.length > 0) {
    lines.push(`Candidate owned accounts (choose from these labels ONLY, or null): ${input.candidateOwnedAccounts.map((a) => `${a.label} (${a.accountType})`).join("; ")}`);
  }
  if (input.knownMandates?.length) lines.push(`Known recurring-payment collectors: ${input.knownMandates.join("; ")}`);
  if (input.recentRelatedEvents?.length) lines.push(`Recent related events: ${input.recentRelatedEvents.join("; ")}`);
  lines.push(`Deterministic system's own classification so far: eventKind=${input.deterministicClassification.eventKind}, paymentRail=${input.deterministicClassification.paymentRail ?? "unknown"}, confidence=${input.deterministicClassification.confidenceLevel}`);
  return lines.join("\n");
}

/** The subset of the Anthropic SDK client this adapter actually uses —
 *  narrow on purpose so tests can inject a fake without constructing a real
 *  Anthropic client or mocking HTTP/the SDK's internals. */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming, options?: { timeout?: number }): Promise<Anthropic.Message>;
  };
}

export class ClaudeSemanticClassifier implements TransactionSemanticClassifier {
  readonly name = "claude";
  constructor(
    private readonly client: MessagesClient,
    private readonly model: string,
  ) {}

  async classify(input: ClassifierInput): Promise<ClassifierOutput | null> {
    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools: [buildTool()],
        tool_choice: { type: "tool", name: TOOL_NAME },
        messages: [{ role: "user", content: buildUserPrompt(input) }],
      },
      { timeout: REQUEST_TIMEOUT_MS },
    );
    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === TOOL_NAME,
    );
    if (!toolUse) return null;
    // Never trust the tool call's `input` as-is, even with strict:true on
    // the tool definition — independently re-validate against the exact
    // same Zod schema every other classifier's output goes through.
    return parseClassifierOutput(toolUse.input);
  }
}

/** Construct a real Claude classifier bound to a real Anthropic client.
 *  The only place `new Anthropic(...)` is ever called in this codebase. */
export function buildClaudeClassifier(cfg: { apiKey: string; model: string }): ClaudeSemanticClassifier {
  const client = new Anthropic({ apiKey: cfg.apiKey });
  return new ClaudeSemanticClassifier(client, cfg.model);
}
