import { logger } from "../../logger.js";
import { getClassifier, transactionAiEnabled } from "./registry.js";
import { parseClassifierOutput, type ClassifierInput, type ClassifierOutput } from "./types.js";

// ---------------------------------------------------------------------------
// Safe AI invocation + confidence policy (§8) — the ONLY way the rest of the
// app should ever call the AI classifier. Guarantees:
//   - disabled (default) -> never calls the provider, returns null instantly
//   - any error/timeout/invalid response -> null, never thrown to the caller
//   - the raw response is ALWAYS schema-validated before use
//   - the AI's suggestion is graded into an AiAdvisoryDecision the caller
//     applies according to the confidence policy below — the AI's own
//     opinion of its confidence is never taken at face value for HIGH
// ---------------------------------------------------------------------------

const AI_TIMEOUT_MS = 4000;
const TIMEOUT = Symbol("transaction-ai-timeout");

export type AiAdvisoryAction = "IGNORE" | "SUGGEST" | "ALLOW_AUTOMATIC";

export interface AiAdvisoryDecision {
  action: AiAdvisoryAction;
  output: ClassifierOutput | null;
}

// ---------------------------------------------------------------------------
// Observability (§9) — safe operational events only. Never logs the prompt,
// the raw response, an API key, or any redacted-but-still-sensitive field —
// only the provider name, a numeric confidence, and an outcome/action label.
// Provider-agnostic: rate-limit detection below duck-types a `.status`/
// `.statusCode` field (which every mainstream HTTP client's error, including
// Anthropic's APIError, exposes) rather than importing a specific SDK's
// exception classes here — this module must never be coupled to one provider.
// ---------------------------------------------------------------------------

export type AiObservabilityEvent =
  | "AI_REQUESTED" | "AI_SKIPPED_HIGH_DETERMINISTIC_CONFIDENCE" | "AI_SKIPPED_USER_MAPPING"
  | "AI_SUCCESS" | "AI_TIMEOUT" | "AI_RATE_LIMIT" | "AI_PROVIDER_ERROR" | "AI_INVALID_RESPONSE"
  | "AI_SUGGESTION_ACCEPTED" | "AI_SUGGESTION_SURFACED" | "AI_SUGGESTION_REJECTED";

function logAiEvent(event: AiObservabilityEvent, meta?: { provider?: string; confidence?: number; action?: AiAdvisoryAction }): void {
  logger.info(event, meta);
}

/** Exported so callers that skip the AI for a reason THEY decided (e.g.
 *  financial-event.service.ts finding strong account-identity evidence, or
 *  a user-confirmed CounterpartyAccountMapping) still emit a real, safe
 *  observability event — the AI was never even asked, so classifyAdvisory()
 *  itself never runs and can't log it. */
export function logAiSkippedForStrongEvidence(): void {
  logAiEvent("AI_SKIPPED_USER_MAPPING");
}

function isRateLimitError(err: unknown): boolean {
  const status = (err as { status?: unknown; statusCode?: unknown } | null)?.status ?? (err as { statusCode?: unknown } | null)?.statusCode;
  return status === 429;
}

/**
 * Confidence policy:
 *   - deterministic confidence HIGH        -> AI is never consulted for the
 *     ledger-affecting fields (the caller shouldn't even call classify() in
 *     this case, but if it does, the result is graded IGNORE regardless of
 *     what the AI says — provider/deterministic evidence wins on conflict).
 *   - AI confidence >= 0.75 AND deterministic confidence is at least MEDIUM
 *     (some supporting evidence, not a bare guess) -> ALLOW_AUTOMATIC, the
 *     caller MAY use the AI's analyticsRole/eventKind refinement.
 *   - AI confidence >= 0.5 -> SUGGEST: visible to the user (Review /
 *     explainability), never auto-applied.
 *   - below that -> IGNORE.
 * ALLOW_AUTOMATIC never means "post a transaction" — see
 * financial-event.service.ts: the AI can only ever refine
 * classification/analyticsRole metadata on an event the deterministic
 * ledger-posting policy has already decided is postable.
 */
export function gradeAiOutput(output: ClassifierOutput | null, deterministicConfidence: "HIGH" | "MEDIUM" | "LOW"): AiAdvisoryDecision {
  if (!output) return { action: "IGNORE", output: null };
  if (deterministicConfidence === "HIGH") return { action: "IGNORE", output };
  if (output.confidence >= 0.75 && deterministicConfidence === "MEDIUM") return { action: "ALLOW_AUTOMATIC", output };
  if (output.confidence >= 0.5) return { action: "SUGGEST", output };
  return { action: "IGNORE", output };
}

/**
 * Call the configured classifier safely: disabled -> instant null; any
 * error/timeout -> null (never throws); any schema-invalid response ->
 * discarded (never partially trusted). This is deliberately the ONLY
 * exported way to reach a classifier's `classify()` — no caller ever holds
 * a raw classifier reference.
 */
export async function classifyAdvisory(input: ClassifierInput): Promise<ClassifierOutput | null> {
  if (!transactionAiEnabled()) return null; // the expected default path — not logged; logging every ingestion while AI is off is noise, not observability
  const classifier = getClassifier();
  logAiEvent("AI_REQUESTED", { provider: classifier.name });

  let raced: unknown;
  try {
    raced = await Promise.race([
      classifier.classify(input),
      new Promise<typeof TIMEOUT>((resolve) => {
        const t = setTimeout(() => resolve(TIMEOUT), AI_TIMEOUT_MS);
        // Don't keep the process alive just for this timer.
        (t as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } catch (err) {
    // Provider error (HTTP error, rate limit, network failure, thrown
    // exception) — advisory only, never propagated to the caller. Never
    // logs the caught error's message/body: it may embed request/response
    // detail from an HTTP client that this module has no way to guarantee
    // is secret-free — only whether it looked like a 429, safe to know.
    logAiEvent(isRateLimitError(err) ? "AI_RATE_LIMIT" : "AI_PROVIDER_ERROR", { provider: classifier.name });
    return null;
  }
  if (raced === TIMEOUT) {
    logAiEvent("AI_TIMEOUT", { provider: classifier.name });
    return null;
  }
  if (raced == null) return null; // classifier had no opinion — not an error

  const parsed = parseClassifierOutput(raced);
  if (!parsed) {
    logAiEvent("AI_INVALID_RESPONSE", { provider: classifier.name });
    return null;
  }
  logAiEvent("AI_SUCCESS", { provider: classifier.name, confidence: parsed.confidence });
  return parsed;
}

/** Convenience: call + grade in one step, given the deterministic confidence
 *  already computed for this event. */
export async function classifyAndGrade(input: ClassifierInput, deterministicConfidence: "HIGH" | "MEDIUM" | "LOW"): Promise<AiAdvisoryDecision> {
  if (deterministicConfidence === "HIGH") {
    logAiEvent("AI_SKIPPED_HIGH_DETERMINISTIC_CONFIDENCE");
    return { action: "IGNORE", output: null }; // never even call the provider — nothing to gain, and §8/§9 cost control
  }
  const output = await classifyAdvisory(input);
  const decision = gradeAiOutput(output, deterministicConfidence);
  if (output) {
    logAiEvent(
      decision.action === "ALLOW_AUTOMATIC" ? "AI_SUGGESTION_ACCEPTED" : decision.action === "SUGGEST" ? "AI_SUGGESTION_SURFACED" : "AI_SUGGESTION_REJECTED",
      { action: decision.action, confidence: output.confidence },
    );
  }
  return decision;
}
