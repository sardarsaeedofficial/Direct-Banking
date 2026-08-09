import { env } from "../../env.js";
import type { BankDataProvider } from "./provider.js";
import { buildTrueLayerProvider } from "./truelayer-provider.js";

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
