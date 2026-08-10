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
import { UnsupportedOperationError } from "./provider.js";

// TrueLayer Data API v3 adapter, verified against the official Data v3 reference
// (docs.truelayer.com/reference: create-connection, get-accounts (connected-accounts)).
//
// Data v3 uses a SERVER client-credentials token (scope "data") plus a Connection-Id
// header — there is no per-user authorization-code / access-token / refresh-token
// model, and no /data/v1/* endpoints. Verified lifecycle:
//   POST /v3/data-connections   (client-credentials token; scopes/provider_selection/
//                                user/user_consent/hosted_page/data_access_type)
//     → 201 { id, status, hosted_page: { uri } }
//   user completes the hosted TrueLayer/bank journey → returns to our return_uri
//   GET  /v3/data-connections/{id}   → resolve/verify the connection status
//   GET  /v3/connected-accounts      (Connection-Id header) → { items, pagination.next_cursor }
//
// IMPORTANT: Data API v3 does NOT currently document account balance or transaction
// endpoints (those live only in Data API v1, which this provider must not call), and
// it exposes no connection-delete endpoint. Accordingly BALANCES and TRANSACTIONS are
// reported UNSUPPORTED here, and revocation is handled locally. When TrueLayer publishes
// v3 balance/transaction endpoints, implement them here and re-enable the capabilities.

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
    // Data v3 exposes connected accounts (+ holder names) but not balances or
    // transactions — those remain Data v1 only, which we must not call.
    return new Set<ProviderCapability>(["ACCOUNTS", "ACCOUNT_HOLDER_NAMES"]);
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
    // Our one-time application nonce travels on our own return_uri; it is not a
    // provider OAuth state. hosted_page (type authorization_flow) yields the hosted
    // authorization URI and the redirect target after completion.
    const returnUri = `${input.returnUri}${input.returnUri.includes("?") ? "&" : "?"}state=${encodeURIComponent(input.state)}`;
    const u = input.user ?? {};
    const requestBody = {
      scopes: this.cfg.scopes,
      provider_selection: { type: "user_selected" as const },
      user: { id: u.id ?? input.userId, name: u.name ?? "Direct Banking user", email: u.email ?? undefined, phone: u.phone ?? undefined },
      user_consent: { type: "authorization_flow_captured" as const },
      hosted_page: { type: "authorization_flow" as const, return_uri: returnUri, country_code: "GB", language_code: "en" },
      data_access_type: "recurring" as const,
    };
    const body = await this.apiFetch<{ id?: string; status?: string; hosted_page?: { uri?: string } }>("/v3/data-connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const providerConnectionId = body.id;
    const authorizationUrl = body.hosted_page?.uri;
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
    type Identifier = { type?: string; iban?: string; account_number?: string; sort_code?: string };
    type Row = {
      id: string; type?: string; account_type?: string; currency: string; customer_segment?: string; bic?: string;
      account_identifiers?: Identifier[];
      account_holder_names?: string[];
      provider?: { display_name?: string; provider_id?: string };
    };
    type Page = { items?: Row[]; pagination?: { next_cursor?: string } };

    const out: ProviderAccount[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const data = await this.apiFetch<Page>(`/v3/connected-accounts${suffix}`, {}, secret.providerConnectionId);
      for (const r of data.items ?? []) {
        const ids = r.account_identifiers ?? [];
        out.push({
          providerAccountId: r.id,
          displayName: r.account_holder_names?.[0] ?? null,
          accountType: r.account_type ?? r.type ?? null,
          currency: r.currency,
          institutionName: r.provider?.display_name ?? null,
          institutionProviderId: r.provider?.provider_id ?? null,
          accountHolderName: r.account_holder_names?.[0] ?? null,
          maskedAccountNumber: mask(ids.find((i) => i.account_number)?.account_number),
          maskedSortCode: mask(ids.find((i) => i.sort_code)?.sort_code),
          maskedIban: mask(ids.find((i) => i.iban)?.iban),
          ownershipKey: r.id,
        });
      }
      cursor = data.pagination?.next_cursor ?? undefined;
      if (!cursor) break;
    }
    return out;
  }

  // Data API v3 does not expose account balances — do NOT fall back to Data v1.
  async getBalances(_secret: ProviderConnectionSecret, _providerAccountId: string): Promise<ProviderBalance> {
    throw new UnsupportedOperationError("BALANCES (not available in TrueLayer Data API v3)");
  }

  // Data API v3 does not expose account transactions — do NOT fall back to Data v1.
  async getTransactions(_secret: ProviderConnectionSecret, _providerAccountId: string, _opts?: GetTransactionsOptions): Promise<ProviderTransaction[]> {
    throw new UnsupportedOperationError("TRANSACTIONS (not available in TrueLayer Data API v3)");
  }

  // Data API v3 documents no connection-delete endpoint; revocation is handled
  // locally (we drop stored material) and by the user withdrawing consent at the
  // bank. We must not call a v1/legacy delete-credential endpoint.
  async revokeConnection(_secret: ProviderConnectionSecret): Promise<void> {
    return;
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
