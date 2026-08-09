import type {
  BankDataProvider,
  ExchangeCallbackInput,
  ExchangeCallbackResult,
  GetTransactionsOptions,
  ProviderAccount,
  ProviderBalance,
  ProviderCapability,
  ProviderConnectionSecret,
  ProviderTransaction,
  StartConnectionInput,
  StartConnectionResult,
} from "./provider.js";

// TrueLayer Data API adapter (Phase 3, "Data v3" family). Endpoint hosts are
// configurable per environment; the documented, stable Data API paths are used
// (/connect/token, /data/v1/accounts, .../balance, .../transactions). These MUST
// be verified against the official TrueLayer OpenAPI before production activation
// — nothing here is exercised by CI, which uses a fake provider.
//
// Security: the client secret is used server-side only; tokens are never logged;
// requests time out and are retried a bounded number of times; provider errors
// are sanitised before surfacing.

interface TrueLayerConfig {
  clientId: string;
  clientSecret: string;
  returnUri: string;
  authBase: string; // e.g. https://auth.truelayer-sandbox.com
  apiBase: string; // e.g. https://api.truelayer-sandbox.com
  scopes: string; // "accounts balance transactions"
}

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;

function mask(value: string | null | undefined): string | null {
  if (!value) return null;
  const s = value.replace(/\s+/g, "");
  return s.length <= 4 ? `••${s}` : `••••${s.slice(-4)}`;
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(timer);
      // Retry only transient upstream failures.
      if (res.status >= 500 && attempt < MAX_RETRIES) continue;
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt >= MAX_RETRIES) break;
    }
  }
  throw new Error(`Provider request failed: ${sanitizeError(lastErr)}`);
}

function sanitizeError(err: unknown): string {
  // Never surface tokens/secrets; a generic message plus a coarse type is enough.
  const name = err instanceof Error ? err.name : "Error";
  return name === "AbortError" ? "timeout" : "network error";
}

export class TrueLayerDataV3Provider implements BankDataProvider {
  readonly name = "truelayer";
  constructor(private readonly cfg: TrueLayerConfig) {}

  capabilities(): Set<ProviderCapability> {
    return new Set<ProviderCapability>(["ACCOUNTS", "BALANCES", "TRANSACTIONS", "ACCOUNT_HOLDER_NAMES"]);
  }
  // The Data v3 adapter does not expose a DD-mandate endpoint; Phase 2 inference
  // continues to own Direct Debit history (see §14).
  supportsDirectDebitMandates(): boolean {
    return false;
  }

  async createConnection(input: StartConnectionInput): Promise<StartConnectionResult> {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.cfg.clientId,
      scope: this.cfg.scopes,
      redirect_uri: input.returnUri,
      providers: "uk-ob-all uk-oauth-all",
      state: input.state,
    });
    return { authorizationUrl: `${this.cfg.authBase}/?${params.toString()}` };
  }

  private async exchange(body: Record<string, string>): Promise<ProviderConnectionSecret> {
    const res = await timedFetch(`${this.cfg.authBase}/connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    if (!res.ok) throw new Error("Token exchange failed");
    const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    return {
      providerConnectionId: json.refresh_token ?? json.access_token.slice(0, 12),
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
    };
  }

  async exchangeCallback(input: ExchangeCallbackInput): Promise<ExchangeCallbackResult> {
    const secret = await this.exchange({
      grant_type: "authorization_code",
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      redirect_uri: this.cfg.returnUri,
      code: input.code,
    });
    return { secret, consentExpiresAt: secret.expiresAt ?? null };
  }

  private async refresh(secret: ProviderConnectionSecret): Promise<ProviderConnectionSecret> {
    if (!secret.refreshToken) return secret;
    return this.exchange({
      grant_type: "refresh_token",
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      refresh_token: secret.refreshToken,
    });
  }

  private async authedGet<T>(secret: ProviderConnectionSecret, path: string): Promise<T> {
    const res = await timedFetch(`${this.cfg.apiBase}${path}`, {
      headers: { authorization: `Bearer ${secret.accessToken}`, accept: "application/json" },
    });
    if (res.status === 401) throw new Error("REAUTH_REQUIRED");
    if (!res.ok) throw new Error("Provider data request failed");
    return (await res.json()) as T;
  }

  async getConnectionStatus(secret: ProviderConnectionSecret): Promise<"ACTIVE" | "REAUTH_REQUIRED" | "EXPIRED" | "REVOKED"> {
    try {
      await this.authedGet(secret, "/data/v1/accounts");
      return "ACTIVE";
    } catch (err) {
      return err instanceof Error && err.message === "REAUTH_REQUIRED" ? "REAUTH_REQUIRED" : "ERROR" as never;
    }
  }

  async listAccounts(secret: ProviderConnectionSecret): Promise<ProviderAccount[]> {
    type Row = {
      account_id: string; account_type?: string; display_name?: string; currency: string;
      account_number?: { iban?: string; number?: string; sort_code?: string };
      provider?: { display_name?: string; provider_id?: string };
    };
    const data = await this.authedGet<{ results: Row[] }>(secret, "/data/v1/accounts");
    return data.results.map((r) => ({
      providerAccountId: r.account_id,
      displayName: r.display_name ?? null,
      accountType: r.account_type ?? null,
      currency: r.currency,
      institutionName: r.provider?.display_name ?? null,
      institutionProviderId: r.provider?.provider_id ?? null,
      maskedAccountNumber: mask(r.account_number?.number),
      maskedSortCode: mask(r.account_number?.sort_code),
      maskedIban: mask(r.account_number?.iban),
      ownershipKey: r.account_id,
    }));
  }

  async getBalances(secret: ProviderConnectionSecret, providerAccountId: string): Promise<ProviderBalance> {
    type Row = { currency: string; current: number; available?: number };
    const data = await this.authedGet<{ results: Row[] }>(secret, `/data/v1/accounts/${providerAccountId}/balance`);
    const b = data.results[0];
    return {
      providerAccountId,
      currentMinor: Math.round((b?.current ?? 0) * 100),
      availableMinor: b?.available != null ? Math.round(b.available * 100) : null,
      currency: b?.currency ?? "GBP",
    };
  }

  async getTransactions(secret: ProviderConnectionSecret, providerAccountId: string, opts?: GetTransactionsOptions): Promise<ProviderTransaction[]> {
    type Row = {
      transaction_id: string; timestamp: string; description?: string; amount: number; currency: string;
      transaction_type?: string; transaction_category?: string; merchant_name?: string;
      meta?: { provider_transaction_category?: string };
    };
    const q = new URLSearchParams();
    if (opts?.fromIso) q.set("from", opts.fromIso);
    if (opts?.toIso) q.set("to", opts.toIso);
    const suffix = q.toString() ? `?${q.toString()}` : "";
    const data = await this.authedGet<{ results: Row[] }>(secret, `/data/v1/accounts/${providerAccountId}/transactions${suffix}`);
    return data.results.map((r) => {
      const credit = (r.transaction_type ?? "").toUpperCase() === "CREDIT" || r.amount > 0;
      const isDd = (r.transaction_category ?? "").toUpperCase().includes("DIRECT_DEBIT");
      return {
        providerTransactionId: r.transaction_id,
        providerAccountId,
        amountMinor: Math.abs(Math.round(r.amount * 100)),
        currency: r.currency,
        direction: credit ? "INCOME" : "EXPENSE",
        status: "SETTLED",
        bookedAt: r.timestamp,
        merchantName: r.merchant_name ?? null,
        description: r.description ?? null,
        category: r.transaction_category ?? null,
        isDirectDebit: isDd,
      } satisfies ProviderTransaction;
    });
  }

  async revokeConnection(secret: ProviderConnectionSecret): Promise<void> {
    // Best-effort revocation; consent is also removable from the bank side.
    try {
      await timedFetch(`${this.cfg.authBase}/connect/token/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: secret.refreshToken ?? secret.accessToken }).toString(),
      });
    } catch {
      // Ignore — the connection is marked REVOKED locally regardless.
    }
  }
}

export function buildTrueLayerProvider(cfg: {
  clientId: string; clientSecret: string; returnUri: string; env: "sandbox" | "live";
}): TrueLayerDataV3Provider {
  const authBase = cfg.env === "live" ? "https://auth.truelayer.com" : "https://auth.truelayer-sandbox.com";
  const apiBase = cfg.env === "live" ? "https://api.truelayer.com" : "https://api.truelayer-sandbox.com";
  return new TrueLayerDataV3Provider({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    returnUri: cfg.returnUri,
    authBase,
    apiBase,
    scopes: "accounts balance transactions",
  });
}
