import type {
  BankDataProvider,
  ConnectionState,
  GetTransactionsOptions,
  ProviderAccount,
  ProviderBalance,
  ProviderCapability,
  ProviderConnectionSecret,
  ProviderTransaction,
  ResolveConnectionResult,
  StartConnectionInput,
  StartConnectionResult,
} from "./provider.js";

// TrueLayer Data API v3 adapter.
//
// Data v3 uses a SERVER client-credentials token (scope "data") plus a connection
// id — there is no per-user authorization-code / access-token / refresh-token
// model, and no /data/v1/* endpoints. The lifecycle is:
//   POST /v3/data-connections  (client-credentials token, scopes accounts/balance/transactions)
//     → { id, authorization_uri }
//   user completes the hosted TrueLayer/bank journey → returns to our return URI
//   GET  /v3/data-connections/{id}         → resolve/verify the connection state
//   GET  /v3/connected-accounts            (Connection-Id header)
//   GET  /v3/connected-accounts/{id}/balance
//   GET  /v3/connected-accounts/{id}/transactions?cursor=…   (cursor pagination)
//   DELETE /v3/data-connections/{id}       → revoke
//
// Endpoint hosts are configurable per environment. The exact request/response
// shapes must be confirmed against the current official Data v3 OpenAPI before
// production activation; CI exercises this adapter with mocked v3 fixtures.

interface TrueLayerConfig {
  clientId: string;
  clientSecret: string;
  returnUri: string;
  authBase: string; // e.g. https://auth.truelayer-sandbox.com
  apiBase: string; // e.g. https://api.truelayer-sandbox.com
  scopes: string[]; // ["accounts","balance","transactions"] — never "info" for recurring access
}

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const MAX_PAGES = 50;

/** Raised for reauthorization-required (403) so callers can flip connection state. */
export class ReauthRequiredError extends Error {
  constructor() {
    super("REAUTH_REQUIRED");
    this.name = "ReauthRequiredError";
  }
}

function mask(value: string | null | undefined): string | null {
  if (!value) return null;
  const s = value.replace(/\s+/g, "");
  return s.length <= 4 ? `••${s}` : `••••${s.slice(-4)}`;
}

function sanitizeError(err: unknown): string {
  const name = err instanceof Error ? err.name : "Error";
  return name === "AbortError" ? "timeout" : "network error";
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class TrueLayerDataV3Provider implements BankDataProvider {
  readonly name = "truelayer";
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly cfg: TrueLayerConfig) {}

  capabilities(): Set<ProviderCapability> {
    return new Set<ProviderCapability>(["ACCOUNTS", "BALANCES", "TRANSACTIONS", "ACCOUNT_HOLDER_NAMES"]);
  }
  // The Data v3 adapter exposes no DD-mandate endpoint; Phase 2 inference owns
  // Direct Debit history (§14).
  supportsDirectDebitMandates(): boolean {
    return false;
  }

  // ── HTTP plumbing ──────────────────────────────────────────────────────────

  private async timedFetch(url: string, init: RequestInit, attempt = 0): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(timer);
      // 429 / 5xx → bounded exponential backoff.
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get("retry-after")) || 0;
        await sleep(Math.max(retryAfter * 1000, 200 * 2 ** attempt));
        return this.timedFetch(url, init, attempt + 1);
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (attempt < MAX_RETRIES) {
        await sleep(200 * 2 ** attempt);
        return this.timedFetch(url, init, attempt + 1);
      }
      throw new Error(`Provider request failed: ${sanitizeError(err)}`);
    }
  }

  /** Server-side client-credentials token with the `data` scope (cached until near expiry). */
  private async dataToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const res = await this.timedFetch(`${this.cfg.authBase}/connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        scope: "data",
      }).toString(),
    });
    if (!res.ok) throw new Error("Client-credentials token request failed");
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    if (!json.access_token) throw new Error("Malformed token response");
    this.token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async apiFetch<T>(path: string, init: RequestInit = {}, connectionId?: string): Promise<T> {
    const doCall = async (token: string) => {
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json", ...(init.headers as Record<string, string> | undefined) };
      if (connectionId) headers["Connection-Id"] = connectionId;
      return this.timedFetch(`${this.cfg.apiBase}${path}`, { ...init, headers });
    };
    let res = await doCall(await this.dataToken());
    if (res.status === 401) {
      // Token expired/invalid → refresh the client-credentials token once and retry.
      res = await doCall(await this.dataToken(true));
    }
    if (res.status === 403) throw new ReauthRequiredError();
    if (res.status === 204) return {} as T;
    if (!res.ok) throw new Error(`Provider data request failed (${res.status})`);
    try {
      return (await res.json()) as T;
    } catch {
      throw new Error("Malformed provider response");
    }
  }

  // ── Connection lifecycle (Data v3) ────────────────────────────────────────

  async createConnection(input: StartConnectionInput): Promise<StartConnectionResult> {
    // Our one-time application nonce travels on our own return URI; it is not the
    // provider's OAuth state.
    const redirectUri = `${input.returnUri}${input.returnUri.includes("?") ? "&" : "?"}state=${encodeURIComponent(input.state)}`;
    const body = await this.apiFetch<{ id?: string; connection_id?: string; authorization_uri?: string; authorization_url?: string }>(
      "/v3/data-connections",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scopes: this.cfg.scopes, redirect_uri: redirectUri, provider_selection: { providers: "uk-ob-all uk-oauth-all" } }),
      },
    );
    const providerConnectionId = body.id ?? body.connection_id;
    const authorizationUrl = body.authorization_uri ?? body.authorization_url;
    if (!providerConnectionId || !authorizationUrl) throw new Error("Malformed data-connection response");
    return { authorizationUrl, providerConnectionId };
  }

  private mapState(raw: string | undefined): ConnectionState {
    switch ((raw ?? "").toLowerCase()) {
      case "authorized":
      case "active":
        return "ACTIVE";
      case "expired":
        return "EXPIRED";
      case "revoked":
        return "REVOKED";
      case "reauthorization_required":
      case "reauth_required":
        return "REAUTH_REQUIRED";
      default:
        return "PENDING";
    }
  }

  async resolveConnection(secret: ProviderConnectionSecret): Promise<ResolveConnectionResult> {
    const body = await this.apiFetch<{ status?: string; state?: string; provider?: { display_name?: string; provider_id?: string }; consent_expires_at?: string }>(
      `/v3/data-connections/${secret.providerConnectionId}`,
    );
    return {
      status: this.mapState(body.status ?? body.state),
      institutionName: body.provider?.display_name ?? null,
      institutionProviderId: body.provider?.provider_id ?? null,
      consentExpiresAt: body.consent_expires_at ?? null,
    };
  }

  async getConnectionStatus(secret: ProviderConnectionSecret): Promise<ConnectionState> {
    try {
      return (await this.resolveConnection(secret)).status;
    } catch (err) {
      if (err instanceof ReauthRequiredError) return "REAUTH_REQUIRED";
      throw err;
    }
  }

  // ── Data (Data v3 connected-account API) ───────────────────────────────────

  async listAccounts(secret: ProviderConnectionSecret): Promise<ProviderAccount[]> {
    type Row = {
      account_id: string; account_type?: string; display_name?: string; currency: string;
      account_identifiers?: Array<{ type?: string; iban?: string; account_number?: string; sort_code?: string }>;
      account_holder_name?: string;
      provider?: { display_name?: string; provider_id?: string };
    };
    const data = await this.apiFetch<{ results?: Row[]; accounts?: Row[] }>("/v3/connected-accounts", {}, secret.providerConnectionId);
    const rows = data.results ?? data.accounts ?? [];
    return rows.map((r) => {
      const ids = r.account_identifiers ?? [];
      const iban = ids.find((i) => i.iban)?.iban;
      const num = ids.find((i) => i.account_number)?.account_number;
      const sort = ids.find((i) => i.sort_code)?.sort_code;
      return {
        providerAccountId: r.account_id,
        displayName: r.display_name ?? null,
        accountType: r.account_type ?? null,
        currency: r.currency,
        institutionName: r.provider?.display_name ?? null,
        institutionProviderId: r.provider?.provider_id ?? null,
        accountHolderName: r.account_holder_name ?? null,
        maskedAccountNumber: mask(num),
        maskedSortCode: mask(sort),
        maskedIban: mask(iban),
        ownershipKey: r.account_id,
      };
    });
  }

  async getBalances(secret: ProviderConnectionSecret, providerAccountId: string): Promise<ProviderBalance> {
    type Row = { currency: string; current: number; available?: number };
    const data = await this.apiFetch<{ results?: Row[]; balance?: Row }>(`/v3/connected-accounts/${providerAccountId}/balance`, {}, secret.providerConnectionId);
    const b = data.results?.[0] ?? data.balance;
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
      transaction_type?: string; transaction_category?: string; merchant_name?: string; status?: string; settled_at?: string;
    };
    type Page = { results?: Row[]; transactions?: Row[]; cursor?: string; next_cursor?: string; next?: string };
    const out: ProviderTransaction[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams();
      if (opts?.fromIso) q.set("from", opts.fromIso);
      if (opts?.toIso) q.set("to", opts.toIso);
      if (cursor) q.set("cursor", cursor);
      const suffix = q.toString() ? `?${q.toString()}` : "";
      const data = await this.apiFetch<Page>(`/v3/connected-accounts/${providerAccountId}/transactions${suffix}`, {}, secret.providerConnectionId);
      const rows = data.results ?? data.transactions ?? [];
      for (const r of rows) {
        const credit = (r.transaction_type ?? "").toUpperCase() === "CREDIT" || r.amount > 0;
        const settled = (r.status ?? "settled").toLowerCase() !== "pending";
        out.push({
          providerTransactionId: r.transaction_id,
          providerAccountId,
          amountMinor: Math.abs(Math.round(r.amount * 100)),
          currency: r.currency,
          direction: credit ? "INCOME" : "EXPENSE",
          status: settled ? "SETTLED" : "PENDING",
          bookedAt: r.timestamp,
          settledAt: r.settled_at ?? null,
          merchantName: r.merchant_name ?? null,
          description: r.description ?? null,
          category: r.transaction_category ?? null,
          isDirectDebit: (r.transaction_category ?? "").toUpperCase().includes("DIRECT_DEBIT"),
        });
      }
      cursor = data.next_cursor ?? data.cursor ?? undefined;
      if (!cursor) break;
    }
    return out;
  }

  async revokeConnection(secret: ProviderConnectionSecret): Promise<void> {
    try {
      await this.apiFetch(`/v3/data-connections/${secret.providerConnectionId}`, { method: "DELETE" });
    } catch {
      // Best-effort; the connection is marked REVOKED locally regardless.
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
    scopes: ["accounts", "balance", "transactions"],
  });
}
