import { env } from "../../env.js";
import { NullSemanticClassifier } from "./null-classifier.js";
import { buildClaudeClassifier } from "./claude-classifier.js";
import type { TransactionSemanticClassifier } from "./types.js";

// Resolves the active AI semantic classifier without coupling callers to a
// concrete provider — mirrors services/open-banking/registry.ts exactly, one
// registry per external-integration category. Tests inject a fake via
// setClassifierForTests so CI needs no real API key, and never construct a
// real Anthropic client.

let override: TransactionSemanticClassifier | null = null;
let cached: TransactionSemanticClassifier | null = null;
let cachedKey: string | null = null;

/** Test seam: force a specific classifier (e.g. FakeSemanticClassifier). Pass null to reset. */
export function setClassifierForTests(classifier: TransactionSemanticClassifier | null): void {
  override = classifier;
  cached = null;
  cachedKey = null;
}

export function transactionAiEnabled(): boolean {
  return env.TRANSACTION_AI_ENABLED;
}

/**
 * The configured classifier. Falls back to the null (always-no-opinion)
 * classifier whenever AI is disabled, enabled without a recognised provider,
 * or missing required config — advisory failure/misconfiguration must NEVER
 * break ingestion; the deterministic engine keeps working exactly as if AI
 * were never built. Cached per (provider, model, apiKey) tuple so a real
 * Anthropic client isn't reconstructed on every notification.
 */
export function getClassifier(): TransactionSemanticClassifier {
  if (override) return override;
  if (!env.TRANSACTION_AI_ENABLED) return new NullSemanticClassifier();

  if (env.TRANSACTION_AI_PROVIDER === "claude" && env.TRANSACTION_AI_API_KEY) {
    const model = env.TRANSACTION_AI_MODEL || "claude-opus-5";
    const key = `claude:${model}:${env.TRANSACTION_AI_API_KEY}`;
    if (cached && cachedKey === key) return cached;
    cached = buildClaudeClassifier({ apiKey: env.TRANSACTION_AI_API_KEY, model });
    cachedKey = key;
    return cached;
  }
  // Enabled, but no recognised provider chosen, or the provider's required
  // config (API key) is missing — NOT_CONFIGURED, never a guessed adapter.
  return new NullSemanticClassifier();
}

// ---------------------------------------------------------------------------
// Readiness — a safe, non-secret summary mirroring
// services/open-banking/registry.ts's getReadiness() exactly, so an operator
// (or a future admin UI) can tell "disabled" apart from "enabled but
// misconfigured" without guessing from behaviour. Never returns a credential
// value — only which named variable is missing.
// ---------------------------------------------------------------------------

export type TransactionAiReadinessReason = "DISABLED" | "NOT_CONFIGURED" | "READY";

export interface TransactionAiReadiness {
  enabled: boolean;
  provider: string | null;
  model: string | null;
  reason: TransactionAiReadinessReason;
  missing: string[];
}

export const SUPPORTED_TRANSACTION_AI_PROVIDERS = ["claude"] as const;

export interface TransactionAiConfigInput {
  enabled: boolean;
  provider?: string;
  model?: string;
  apiKey?: string;
}

/** Pure decision logic (independent of the process-wide env singleton) — the
 *  actual readiness rules, directly unit-testable with fabricated config. */
export function computeTransactionAiReadiness(cfg: TransactionAiConfigInput): TransactionAiReadiness {
  const provider = cfg.provider ?? null;
  if (!cfg.enabled) {
    return { enabled: false, provider, model: null, reason: "DISABLED", missing: [] };
  }
  if (!provider || !(SUPPORTED_TRANSACTION_AI_PROVIDERS as readonly string[]).includes(provider)) {
    return { enabled: true, provider, model: null, reason: "NOT_CONFIGURED", missing: ["TRANSACTION_AI_PROVIDER"] };
  }
  const missing: string[] = [];
  if (!cfg.apiKey) missing.push("TRANSACTION_AI_API_KEY");
  const model = cfg.model || "claude-opus-5";
  return { enabled: true, provider, model, reason: missing.length === 0 ? "READY" : "NOT_CONFIGURED", missing };
}

export function getTransactionAiReadiness(): TransactionAiReadiness {
  return computeTransactionAiReadiness({
    enabled: env.TRANSACTION_AI_ENABLED,
    provider: env.TRANSACTION_AI_PROVIDER,
    model: env.TRANSACTION_AI_MODEL,
    apiKey: env.TRANSACTION_AI_API_KEY,
  });
}
