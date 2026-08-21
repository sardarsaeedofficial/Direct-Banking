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

export type AiAdvisoryAction = "IGNORE" | "SUGGEST" | "ALLOW_AUTOMATIC";

export interface AiAdvisoryDecision {
  action: AiAdvisoryAction;
  output: ClassifierOutput | null;
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
  if (!transactionAiEnabled()) return null;
  const classifier = getClassifier();
  let raced: unknown;
  try {
    raced = await Promise.race([
      classifier.classify(input),
      new Promise<null>((resolve) => {
        const t = setTimeout(() => resolve(null), AI_TIMEOUT_MS);
        // Don't keep the process alive just for this timer.
        (t as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } catch {
    return null; // provider error — advisory only, never propagated
  }
  if (raced == null) return null;
  return parseClassifierOutput(raced);
}

/** Convenience: call + grade in one step, given the deterministic confidence
 *  already computed for this event. */
export async function classifyAndGrade(input: ClassifierInput, deterministicConfidence: "HIGH" | "MEDIUM" | "LOW"): Promise<AiAdvisoryDecision> {
  if (deterministicConfidence === "HIGH") return { action: "IGNORE", output: null }; // never even call the provider — nothing to gain
  const output = await classifyAdvisory(input);
  return gradeAiOutput(output, deterministicConfidence);
}
