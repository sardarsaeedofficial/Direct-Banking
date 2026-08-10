import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import type {
  BankDataProvider,
  ExchangePublicTokenResult,
  ProviderAccount,
  ProviderBalance,
  ProviderCapability,
  ProviderConnectionSecret,
  ProviderSyncPage,
  ProviderTransaction,
  ResolveConnectionResult,
  StartConnectionInput,
  StartConnectionResult,
} from "./provider.js";

// Plaid adapter — the first fully transaction-capable BankDataProvider.
// Verified against the official Plaid API reference (plaid.com/docs/api):
//   POST /link/token/create        → { link_token, expiration }
//   POST /item/public_token/exchange → { access_token, item_id }
//   POST /accounts/get             → { accounts:[{account_id,name,official_name,type,subtype,mask,balances}], item }
//   POST /accounts/balance/get     → fresh balances
//   POST /transactions/sync        → { added[], modified[], removed[{transaction_id,account_id}], next_cursor, has_more }
//   POST /item/remove              → revoke
//   POST /webhook_verification_key/get → JWK for Plaid-Verification (ES256) webhooks
// Plaid amount sign: POSITIVE = money out of the account (debit/EXPENSE); NEGATIVE = money in (INCOME).
// The client secret is used server-side only; access tokens are never logged.

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;

/** Raised when Plaid says the Item needs re-authentication (ITEM_LOGIN_REQUIRED etc.). */
export class ReauthRequiredError extends Error {
  constructor() {
    super("REAUTH_REQUIRED");
    this.name = "ReauthRequiredError";
  }
}
/** Raised when /transactions/sync data mutated mid-pagination; caller restarts the batch. */
export class SyncMutationError extends Error {
  constructor() {
    super("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION");
    this.name = "SyncMutationError";
  }
}

interface PlaidConfig {
  clientId: string;
  secret: string;
  apiBase: string; // https://sandbox.plaid.com | https://production.plaid.com
  webhookUri?: string;
  countryCodes: string[];
  recurringEnabled: boolean;
}

function mask(value: string | null | undefined): string | null {
  if (!value) return null;
  const s = value.replace(/\s+/g, "");
  return s.length <= 4 ? `••${s}` : `••••${s.slice(-4)}`;
}
function toMinor(n: number | null | undefined): number | null {
  return n == null ? null : Math.round(n * 100);
}
async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

export class PlaidProvider implements BankDataProvider {
  readonly name = "plaid";
  constructor(private readonly cfg: PlaidConfig) {}

  capabilities(): Set<ProviderCapability> {
    const caps: ProviderCapability[] = ["ACCOUNTS", "BALANCES", "TRANSACTIONS"];
    if (this.cfg.recurringEnabled) caps.push("RECURRING_TRANSACTION_INSIGHTS");
    return new Set(caps);
  }
  // Direct Debit detection stays with the Phase 2 inference engine (§14).
  supportsDirectDebitMandates(): boolean { return false; }

  private async post<T>(path: string, body: Record<string, unknown>, attempt = 0): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.cfg.apiBase}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: this.cfg.clientId, secret: this.cfg.secret, ...body }),
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (attempt < MAX_RETRIES) { await sleep(300 * 2 ** attempt); return this.post<T>(path, body, attempt + 1); }
      const name = err instanceof Error ? err.name : "Error";
      throw new Error(`Plaid request failed: ${name === "AbortError" ? "timeout" : "network error"}`);
    }
    clearTimeout(timer);
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(300 * 2 ** attempt);
      return this.post<T>(path, body, attempt + 1);
    }
    if (!res.ok) {
      let code = "";
      try { code = ((await res.json()) as { error_code?: string }).error_code ?? ""; } catch { /* ignore */ }
      if (code === "ITEM_LOGIN_REQUIRED" || code === "ITEM_ERROR") throw new ReauthRequiredError();
      if (code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") throw new SyncMutationError();
      throw new Error(`Plaid API error (${res.status})`);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new Error("Malformed Plaid response");
    }
  }

  async createConnection(input: StartConnectionInput): Promise<StartConnectionResult> {
    const body = await this.post<{ link_token: string }>("/link/token/create", {
      client_name: "Direct Banking",
      language: "en",
      country_codes: this.cfg.countryCodes,
      user: { client_user_id: input.userId },
      products: ["transactions"],
      ...(this.cfg.webhookUri ? { webhook: this.cfg.webhookUri } : {}),
    });
    if (!body.link_token) throw new Error("Malformed link token response");
    // The connection id (Item) is only known after the public-token exchange.
    return { mode: "link_token", linkToken: body.link_token };
  }

  async exchangePublicToken(publicToken: string): Promise<ExchangePublicTokenResult> {
    const body = await this.post<{ access_token: string; item_id: string }>("/item/public_token/exchange", { public_token: publicToken });
    if (!body.access_token || !body.item_id) throw new Error("Malformed token exchange response");
    return { secret: { providerConnectionId: body.access_token }, providerItemId: body.item_id };
  }

  async resolveConnection(secret: ProviderConnectionSecret): Promise<ResolveConnectionResult> {
    // A Plaid Item is active immediately after exchange; check for an error state.
    return { status: await this.getConnectionStatus(secret) };
  }

  async getConnectionStatus(secret: ProviderConnectionSecret): Promise<ResolveConnectionResult["status"]> {
    try {
      const body = await this.post<{ item?: { error?: { error_code?: string } | null } }>("/item/get", { access_token: secret.providerConnectionId });
      return body.item?.error ? "REAUTH_REQUIRED" : "ACTIVE";
    } catch (err) {
      if (err instanceof ReauthRequiredError) return "REAUTH_REQUIRED";
      throw err;
    }
  }

  async listAccounts(secret: ProviderConnectionSecret): Promise<ProviderAccount[]> {
    type Acc = { account_id: string; name?: string; official_name?: string; type?: string; subtype?: string; mask?: string; balances?: { available?: number; current?: number; iso_currency_code?: string } };
    const body = await this.post<{ accounts: Acc[]; item?: { institution_id?: string } }>("/accounts/get", { access_token: secret.providerConnectionId });
    return body.accounts.map((a) => ({
      providerAccountId: a.account_id,
      displayName: a.name ?? a.official_name ?? null,
      accountType: a.subtype ?? a.type ?? null,
      currency: a.balances?.iso_currency_code ?? "GBP",
      institutionName: null,
      institutionProviderId: body.item?.institution_id ?? null,
      accountHolderName: null, // Identity product not requested
      maskedAccountNumber: mask(a.mask),
      maskedSortCode: null,
      maskedIban: null,
      ownershipKey: a.account_id,
      cachedBalanceMinor: toMinor(a.balances?.current),
      cachedAvailableMinor: toMinor(a.balances?.available),
    }));
  }

  async getBalances(secret: ProviderConnectionSecret, providerAccountId: string): Promise<ProviderBalance> {
    // Fresh balance, only when explicitly required.
    type Acc = { account_id: string; balances?: { available?: number; current?: number; iso_currency_code?: string } };
    const body = await this.post<{ accounts: Acc[] }>("/accounts/balance/get", { access_token: secret.providerConnectionId, options: { account_ids: [providerAccountId] } });
    const a = body.accounts.find((x) => x.account_id === providerAccountId) ?? body.accounts[0];
    return {
      providerAccountId,
      currentMinor: toMinor(a?.balances?.current) ?? 0,
      availableMinor: toMinor(a?.balances?.available),
      currency: a?.balances?.iso_currency_code ?? "GBP",
    };
  }

  async syncTransactions(secret: ProviderConnectionSecret, cursor: string | null): Promise<ProviderSyncPage> {
    type Meta = { reference_number?: string; payee?: string; payer?: string; reason?: string };
    type Txn = {
      transaction_id: string; account_id: string; amount: number; iso_currency_code?: string; date?: string; datetime?: string;
      authorized_datetime?: string; name?: string; merchant_name?: string; original_description?: string; pending?: boolean;
      pending_transaction_id?: string | null; payment_meta?: Meta;
    };
    const body = await this.post<{ added: Txn[]; modified: Txn[]; removed: Array<{ transaction_id: string }>; next_cursor: string; has_more: boolean }>(
      "/transactions/sync",
      { access_token: secret.providerConnectionId, ...(cursor ? { cursor } : {}), count: 500, options: { include_original_description: true } },
    );
    const map = (t: Txn): ProviderTransaction => {
      const outflow = t.amount > 0; // Plaid: positive = money out
      return {
        providerTransactionId: t.transaction_id,
        providerAccountId: t.account_id,
        amountMinor: Math.abs(Math.round(t.amount * 100)),
        currency: t.iso_currency_code ?? "GBP",
        direction: outflow ? "EXPENSE" : "INCOME",
        status: t.pending ? "PENDING" : "SETTLED",
        bookedAt: t.datetime ?? t.authorized_datetime ?? (t.date ? `${t.date}T00:00:00Z` : new Date().toISOString()),
        settledAt: t.pending ? null : t.datetime ?? null,
        description: t.name ?? null,
        originalDescription: t.original_description ?? null,
        merchantName: t.merchant_name ?? null,
        recipientName: outflow ? t.payment_meta?.payee ?? null : null,
        senderName: outflow ? null : t.payment_meta?.payer ?? null,
        reference: t.payment_meta?.reference_number ?? null,
        pendingTransactionId: t.pending_transaction_id ?? null,
      };
    };
    return {
      added: (body.added ?? []).map(map),
      modified: (body.modified ?? []).map(map),
      removed: (body.removed ?? []).map((r) => r.transaction_id),
      nextCursor: body.next_cursor,
      hasMore: !!body.has_more,
    };
  }

  async revokeConnection(secret: ProviderConnectionSecret): Promise<void> {
    try {
      await this.post("/item/remove", { access_token: secret.providerConnectionId });
    } catch {
      // Best-effort; the connection is marked REVOKED locally regardless.
    }
  }

  /**
   * Verify a Plaid webhook per the official process: the Plaid-Verification JWT
   * (ES256) is checked against the JWK from /webhook_verification_key/get, the
   * body hash must equal request_body_sha256, and the token must be < 5 min old.
   */
  async verifyWebhook(rawBody: string, jwt: string): Promise<boolean> {
    try {
      const [headerB64, payloadB64, sigB64] = jwt.split(".");
      if (!headerB64 || !payloadB64 || !sigB64) return false;
      const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as { alg?: string; kid?: string };
      if (header.alg !== "ES256" || !header.kid) return false;
      const keyResp = await this.post<{ key: Record<string, unknown> }>("/webhook_verification_key/get", { key_id: header.kid });
      const publicKey = createPublicKey({ key: keyResp.key as never, format: "jwk" });
      const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
      const signature = Buffer.from(sigB64, "base64url");
      const ok = cryptoVerify("sha256", signingInput, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
      if (!ok) return false;
      const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as { iat?: number; request_body_sha256?: string };
      if (!payload.iat || Date.now() / 1000 - payload.iat > 300) return false; // > 5 min old
      const bodyHash = createHash("sha256").update(rawBody).digest("hex");
      return typeof payload.request_body_sha256 === "string" && payload.request_body_sha256 === bodyHash;
    } catch {
      return false;
    }
  }
}

export function buildPlaidProvider(cfg: {
  clientId: string; secret: string; env: "sandbox" | "production"; webhookUri?: string; recurringEnabled?: boolean;
}): PlaidProvider {
  const apiBase = cfg.env === "production" ? "https://production.plaid.com" : "https://sandbox.plaid.com";
  return new PlaidProvider({
    clientId: cfg.clientId,
    secret: cfg.secret,
    apiBase,
    webhookUri: cfg.webhookUri,
    countryCodes: ["GB"],
    recurringEnabled: !!cfg.recurringEnabled,
  });
}
