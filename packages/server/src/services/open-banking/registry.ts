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

/** The configured provider, or null when Open Banking is not usable. */
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
// Readiness (§39/§40) — a safe, non-secret summary of why Bank Connections
// can or cannot start, so Android never has to guess from a single generic
// 503. Traced root cause of "Bank Connections not working" in the current
// default configuration: OPEN_BANKING_ENABLED defaults to false (the
// documented, intentional safe production state — see docs/OPEN_BANKING.md),
// AND separately, OPEN_BANKING_PROVIDER defaults to "truelayer" — so even
// once OPEN_BANKING_ENABLED=true is set, forgetting to also set
// OPEN_BANKING_PROVIDER=plaid (this app's actual integrated provider, via the
// Android Plaid Link SDK) silently selects the wrong provider and still
// reports "not enabled", with no indication that the *provider selection*,
// not just the feature flag, is the problem. Never returns a credential
// value — only which named variables are missing.
// ---------------------------------------------------------------------------

export interface OpenBankingReadiness {
  enabled: boolean;
  provider: string;
  environment: string;
  configured: boolean;
  missing: string[];
}

export function getReadiness(): OpenBankingReadiness {
  const enabled = env.OPEN_BANKING_ENABLED;
  const provider = env.OPEN_BANKING_PROVIDER;
  const missing: string[] = [];
  let environment = "unknown";

  if (provider === "plaid") {
    environment = env.PLAID_ENV;
    if (!env.PLAID_CLIENT_ID) missing.push("PLAID_CLIENT_ID");
    if (!env.PLAID_SECRET) missing.push("PLAID_SECRET");
  } else if (provider === "truelayer") {
    environment = env.TRUELAYER_ENV;
    if (!env.TRUELAYER_CLIENT_ID) missing.push("TRUELAYER_CLIENT_ID");
    if (!env.TRUELAYER_CLIENT_SECRET) missing.push("TRUELAYER_CLIENT_SECRET");
    if (!env.TRUELAYER_RETURN_URI) missing.push("TRUELAYER_RETURN_URI");
  } else {
    missing.push("OPEN_BANKING_PROVIDER"); // set, but not a recognised provider name
  }

  return { enabled, provider, environment, configured: enabled && missing.length === 0, missing };
}
