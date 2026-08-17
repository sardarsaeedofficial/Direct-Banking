import { env } from "../../env.js";
import type { BankDataProvider } from "./provider.js";
import { buildTrueLayerProvider } from "./truelayer-provider.js";
import { buildPlaidProvider } from "./plaid-provider.js";

// Resolves the active provider without coupling callers to a concrete class.
// Tests inject a fake via setProviderForTests so CI needs no real credentials.

let override: BankDataProvider | null = null;
let cached: BankDataProvider | null = null;

/** Test seam: force a specific provider (e.g. a fake). Pass null to reset. */
export function setProviderForTests(provider: BankDataProvider | null): void {
  override = provider;
  cached = null;
}

export function openBankingEnabled(): boolean {
  return env.OPEN_BANKING_ENABLED;
}

/** The configured provider, or null when Open Banking is not usable. Never
 *  falls through to a default provider — OPEN_BANKING_PROVIDER has no
 *  default value (see env.ts) and must match exactly one recognised
 *  provider name, or this returns null just like any other missing
 *  configuration. */
export function getProvider(): BankDataProvider | null {
  if (override) return override;
  if (cached) return cached;
  if (env.OPEN_BANKING_PROVIDER === "plaid" && env.PLAID_CLIENT_ID && env.PLAID_SECRET) {
    cached = buildPlaidProvider({
      clientId: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      env: env.PLAID_ENV,
      webhookUri: env.PLAID_WEBHOOK_URI,
    });
    return cached;
  }
  if (env.OPEN_BANKING_PROVIDER === "truelayer" && env.TRUELAYER_CLIENT_ID && env.TRUELAYER_CLIENT_SECRET && env.TRUELAYER_RETURN_URI) {
    cached = buildTrueLayerProvider({
      clientId: env.TRUELAYER_CLIENT_ID,
      clientSecret: env.TRUELAYER_CLIENT_SECRET,
      returnUri: env.TRUELAYER_RETURN_URI,
      env: env.TRUELAYER_ENV,
    });
    return cached;
  }
  return null;
}

export function returnUri(): string {
  return env.TRUELAYER_RETURN_URI ?? "";
}

// ---------------------------------------------------------------------------
// Readiness (§39/§40, hardened) — a safe, non-secret summary of why Bank
// Connections can or cannot start, so Android never has to guess from a
// single generic 503. Traced root cause of "Bank Connections not working":
// OPEN_BANKING_ENABLED defaults to false (the documented, intentional safe
// production state — see docs/OPEN_BANKING.md); separately,
// OPEN_BANKING_PROVIDER used to default to "truelayer" even though this
// app's Android integration is Plaid, so enabling the flag without also
// naming a provider would silently select the wrong one. Fixed at the
// source: OPEN_BANKING_PROVIDER has NO default (env.ts) — an operator must
// explicitly write OPEN_BANKING_PROVIDER=plaid or =truelayer once enabled,
// or readiness reports NOT_CONFIGURED rather than guessing. Never returns a
// credential value — only which named variables are missing.
// ---------------------------------------------------------------------------

export type OpenBankingReadinessReason = "DISABLED" | "NOT_CONFIGURED" | "READY";

export interface OpenBankingReadiness {
  enabled: boolean;
  provider: string | null;
  environment: string | null;
  configured: boolean;
  reason: OpenBankingReadinessReason;
  missing: string[];
}

// OPEN_BANKING_DATA_KEY encrypts connection material regardless of which
// provider is active (see crypto.ts) — required for both.
const PLAID_REQUIRED_VARS = ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_WEBHOOK_URI", "OPEN_BANKING_DATA_KEY"] as const;
const TRUELAYER_REQUIRED_VARS = ["TRUELAYER_CLIENT_ID", "TRUELAYER_CLIENT_SECRET", "TRUELAYER_RETURN_URI", "OPEN_BANKING_DATA_KEY"] as const;

// Exported for tests/documentation — never used to guess a provider.
export const OPEN_BANKING_PROVIDER_REQUIREMENTS = { plaid: PLAID_REQUIRED_VARS, truelayer: TRUELAYER_REQUIRED_VARS };

export interface OpenBankingConfigInput {
  enabled: boolean;
  provider?: string;
  plaidEnv?: string;
  plaidClientId?: string;
  plaidSecret?: string;
  plaidWebhookUri?: string;
  openBankingDataKey?: string;
  truelayerEnv?: string;
  truelayerClientId?: string;
  truelayerClientSecret?: string;
  truelayerReturnUri?: string;
}

/**
 * Pure decision logic, independent of the process-wide env singleton — this
 * is what actually implements the readiness rules, and it's what tests
 * exercise directly (with fabricated, never-real config) rather than trying
 * to re-parse process.env per test case. getReadiness() below is the only
 * caller that feeds it the real environment.
 */
export function computeReadiness(cfg: OpenBankingConfigInput): OpenBankingReadiness {
  const provider = cfg.provider ?? null;

  if (!cfg.enabled) {
    return { enabled: false, provider, environment: null, configured: false, reason: "DISABLED", missing: [] };
  }

  if (provider !== "plaid" && provider !== "truelayer") {
    // Enabled, but no provider explicitly chosen (or an unrecognised value) —
    // never silently assume one.
    return { enabled: true, provider, environment: null, configured: false, reason: "NOT_CONFIGURED", missing: ["OPEN_BANKING_PROVIDER"] };
  }

  const missing: string[] = [];
  let environment: string;
  if (provider === "plaid") {
    environment = cfg.plaidEnv ?? "sandbox";
    if (!cfg.plaidClientId) missing.push("PLAID_CLIENT_ID");
    if (!cfg.plaidSecret) missing.push("PLAID_SECRET");
    if (!cfg.plaidWebhookUri) missing.push("PLAID_WEBHOOK_URI");
    if (!cfg.openBankingDataKey) missing.push("OPEN_BANKING_DATA_KEY");
  } else {
    // provider === "truelayer" — Plaid variables are never required here.
    environment = cfg.truelayerEnv ?? "sandbox";
    if (!cfg.truelayerClientId) missing.push("TRUELAYER_CLIENT_ID");
    if (!cfg.truelayerClientSecret) missing.push("TRUELAYER_CLIENT_SECRET");
    if (!cfg.truelayerReturnUri) missing.push("TRUELAYER_RETURN_URI");
    if (!cfg.openBankingDataKey) missing.push("OPEN_BANKING_DATA_KEY");
  }

  const configured = missing.length === 0;
  return { enabled: true, provider, environment, configured, reason: configured ? "READY" : "NOT_CONFIGURED", missing };
}

export function getReadiness(): OpenBankingReadiness {
  return computeReadiness({
    enabled: env.OPEN_BANKING_ENABLED,
    provider: env.OPEN_BANKING_PROVIDER,
    plaidEnv: env.PLAID_ENV,
    plaidClientId: env.PLAID_CLIENT_ID,
    plaidSecret: env.PLAID_SECRET,
    plaidWebhookUri: env.PLAID_WEBHOOK_URI,
    openBankingDataKey: env.OPEN_BANKING_DATA_KEY,
    truelayerEnv: env.TRUELAYER_ENV,
    truelayerClientId: env.TRUELAYER_CLIENT_ID,
    truelayerClientSecret: env.TRUELAYER_CLIENT_SECRET,
    truelayerReturnUri: env.TRUELAYER_RETURN_URI,
  });
}
