import { env } from "../../env.js";
import { NullSemanticClassifier } from "./null-classifier.js";
import type { TransactionSemanticClassifier } from "./types.js";

// Resolves the active AI semantic classifier without coupling callers to a
// concrete provider — mirrors services/open-banking/registry.ts exactly.
// Tests inject a fake via setClassifierForTests so CI needs no real API key.

let override: TransactionSemanticClassifier | null = null;

/** Test seam: force a specific classifier (e.g. FakeSemanticClassifier). Pass null to reset. */
export function setClassifierForTests(classifier: TransactionSemanticClassifier | null): void {
  override = classifier;
}

export function transactionAiEnabled(): boolean {
  return env.TRANSACTION_AI_ENABLED;
}

/**
 * The configured classifier. Falls back to the null (always-no-opinion)
 * classifier whenever AI is disabled, or enabled without a recognised
 * provider — advisory failure/misconfiguration must never break ingestion.
 * No real provider adapter ships in this repository (§6/§7: no external
 * dependency is required for automated tests or for the app to function);
 * TRANSACTION_AI_PROVIDER/TRANSACTION_AI_MODEL/TRANSACTION_AI_API_KEY are
 * read here so a real adapter can be wired in later without touching any
 * caller of getClassifier().
 */
export function getClassifier(): TransactionSemanticClassifier {
  if (override) return override;
  if (!env.TRANSACTION_AI_ENABLED) return new NullSemanticClassifier();
  return new NullSemanticClassifier();
}
