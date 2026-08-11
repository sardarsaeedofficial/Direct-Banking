import { afterEach, describe, expect, it, vi } from "vitest";
import { TrueLayerDataV3Provider, ReauthRequiredError } from "./truelayer-provider.js";
import { UnsupportedOperationError } from "./provider.js";

// Contract tests for the REAL Data API v3 HTTP adapter, exercised against mocked
// fixtures that mirror the official Data v3 reference shapes (create-connection,
// data-connections/{id}, connected-accounts). No TrueLayer credentials required.

const cfg = {
  clientId: "cid",
  clientSecret: "csecret",
  returnUri: "https://app.example/api/mobile/v1/bank-connections/callback",
  authBase: "https://auth.tl",
  apiBase: "https://api.tl",
  scopes: ["accounts", "balance", "transactions"],
};
const secret = { providerConnectionId: "conn-1" };
const MALFORMED = Symbol("malformed");

interface Recorded { url: string; init: RequestInit }
const calls: Recorded[] = [];

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => {
      if (body === MALFORMED) throw new Error("bad json");
      return body;
    },
  } as unknown as Response;
}

function mockFetch(handler: (url: string, init: RequestInit, n: number) => Response | Promise<Response> | never) {
  const counts = new Map<string, number>();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const key = url.split("?")[0];
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return handler(url, init, n);
  }));
}
const tokenBody = { access_token: "tok-abc", expires_in: 3600 };
function withToken(onData: (url: string, init: RequestInit, n: number) => Response | Promise<Response>) {
  return (u: string, init: RequestInit, n: number) => (u.endsWith("/connect/token") ? res(200, tokenBody) : onData(u, init, n));
}

afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

describe("TrueLayerDataV3Provider (Data v3 contract)", () => {
  it("reports only ACCOUNTS/ACCOUNT_HOLDER_NAMES (v3 has no balance/transactions)", () => {
    const p = new TrueLayerDataV3Provider(cfg);
    const caps = p.capabilities();
    expect(caps.has("ACCOUNTS")).toBe(true);
    expect(caps.has("ACCOUNT_HOLDER_NAMES")).toBe(true);
    expect(caps.has("BALANCES")).toBe(false);
    expect(caps.has("TRANSACTIONS")).toBe(false);
    expect(p.supportsDirectDebitMandates()).toBe(false);
  });

  it("uses a client-credentials data token and creates a data-connection with the official body", async () => {
    // Official create-connection response: { id, status, hosted_page: { uri } }.
    mockFetch(withToken(() => res(201, { id: "conn-1", status: "authorization_required", hosted_page: { uri: "https://auth.tl/hosted/abc" } })));
    const p = new TrueLayerDataV3Provider(cfg);
    const out = await p.createConnection({ userId: "u1", connectionId: "c", state: "NONCE", returnUri: cfg.returnUri, user: { id: "u1", name: "S Saeed", email: "s@example.com" } });
    expect(out.providerConnectionId).toBe("conn-1");
    expect(out.authorizationUrl).toBe("https://auth.tl/hosted/abc");

    const token = calls.find((c) => c.url.endsWith("/connect/token"))!;
    expect(String(token.init.body)).toContain("grant_type=client_credentials");
    expect(String(token.init.body)).toContain("scope=data");

    const create = calls.find((c) => c.url.endsWith("/v3/data-connections"))!;
    const sent = JSON.parse(String(create.init.body));
    expect(sent.provider_selection).toEqual({ type: "user_selected" });
    expect(sent.user_consent).toEqual({ type: "authorization_flow_captured" });
    expect(sent.user.email).toBe("s@example.com");
    expect(sent.hosted_page.type).toBe("authorization_flow");
    expect(sent.hosted_page.return_uri).toContain("?state=NONCE"); // our nonce rides our return_uri
    expect(sent.data_access_type).toBe("recurring");
    expect(sent.scopes).toEqual(["accounts", "balance", "transactions"]);
    // No Data v1 anywhere.
    expect(calls.every((c) => !c.url.includes("/data/v1/"))).toBe(true);
  });

  it("resolves a connection's status via GET /v3/data-connections/{id}", async () => {
    mockFetch(withToken(() => res(200, { status: "authorized", provider: { display_name: "Monzo", provider_id: "monzo" } })));
    const p = new TrueLayerDataV3Provider(cfg);
    const resolved = await p.resolveConnection(secret);
    expect(resolved.status).toBe("ACTIVE");
    expect(resolved.institutionName).toBe("Monzo");
    expect(calls.some((c) => c.url.endsWith("/v3/data-connections/conn-1"))).toBe(true);
  });

  it("lists connected accounts (items + pagination) with the Connection-Id header and masks identifiers", async () => {
    mockFetch(withToken((u) => {
      if (u.includes("cursor=CUR2")) {
        return res(200, { items: [{ id: "a2", type: "account", currency: "GBP", account_holder_names: ["Sardar Saeed"], account_identifiers: [{ type: "iban", iban: "GB00BANK99998888" }] }], pagination: {} });
      }
      return res(200, {
        items: [{
          id: "a1", type: "account", account_type: "current", currency: "GBP",
          account_holder_names: ["Sardar Saeed"],
          account_identifiers: [{ type: "sort_code_account_number", account_number: "12345678", sort_code: "040004" }],
          provider: { display_name: "Monzo", provider_id: "monzo" },
        }],
        pagination: { next_cursor: "CUR2" },
      });
    }));
    const p = new TrueLayerDataV3Provider(cfg);
    const accounts = await p.listAccounts(secret);
    const call = calls.find((c) => c.url.endsWith("/v3/connected-accounts"))!;
    expect(call.url).toBe("https://api.tl/v3/connected-accounts");
    expect((call.init.headers as Record<string, string>)["Connection-Id"]).toBe("conn-1");
    expect(accounts.map((a) => a.providerAccountId)).toEqual(["a1", "a2"]); // paged via next_cursor
    expect(accounts[0].accountHolderName).toBe("Sardar Saeed");
    expect(accounts[0].maskedAccountNumber).toBe("••••5678");
    expect(accounts[0].maskedAccountNumber).not.toContain("12345678");
    expect(accounts[1].maskedIban).toContain("••••");
  });

  it("does not call Data v1 for balances or transactions — reports them unsupported", async () => {
    mockFetch(withToken(() => res(200, {})));
    const p = new TrueLayerDataV3Provider(cfg);
    await expect(p.getBalances(secret, "a1")).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(p.getTransactions(secret, "a1")).rejects.toBeInstanceOf(UnsupportedOperationError);
    // No HTTP requests were made for these operations.
    expect(calls.length).toBe(0);
  });

  it("refreshes the token and retries once on 401", async () => {
    mockFetch(withToken((u, _i, n) => (n === 1 ? res(401, {}) : res(200, { items: [] }))));
    const p = new TrueLayerDataV3Provider(cfg);
    await p.listAccounts(secret);
    expect(calls.filter((c) => c.url.endsWith("/connect/token")).length).toBe(2);
    expect(calls.filter((c) => c.url.endsWith("/v3/connected-accounts")).length).toBe(2);
  });

  it("maps 403 to a reauthorization-required error / state", async () => {
    mockFetch(withToken(() => res(403, {})));
    const p = new TrueLayerDataV3Provider(cfg);
    await expect(p.listAccounts(secret)).rejects.toBeInstanceOf(ReauthRequiredError);
    mockFetch(withToken(() => res(403, {})));
    expect(await p.getConnectionStatus(secret)).toBe("REAUTH_REQUIRED");
  });

  it("retries on 429 and then succeeds", async () => {
    mockFetch(withToken((u, _i, n) => (n === 1 ? res(429, {}, { "retry-after": "0" }) : res(200, { items: [] }))));
    const p = new TrueLayerDataV3Provider(cfg);
    await p.listAccounts(secret);
    expect(calls.filter((c) => c.url.endsWith("/v3/connected-accounts")).length).toBe(2);
  });

  it("fails after exhausting retries on 5xx", async () => {
    mockFetch(withToken(() => res(503, {})));
    const p = new TrueLayerDataV3Provider(cfg);
    await expect(p.listAccounts(secret)).rejects.toThrow(/failed/i);
    expect(calls.filter((c) => c.url.endsWith("/v3/connected-accounts")).length).toBe(3);
  });

  it("rejects a malformed provider response", async () => {
    mockFetch(withToken(() => res(200, MALFORMED)));
    const p = new TrueLayerDataV3Provider(cfg);
    await expect(p.listAccounts(secret)).rejects.toThrow(/malformed/i);
  });

  it("surfaces a timeout as a sanitised error", async () => {
    mockFetch(withToken(() => { const e = new Error("aborted"); e.name = "AbortError"; throw e; }));
    const p = new TrueLayerDataV3Provider(cfg);
    await expect(p.listAccounts(secret)).rejects.toThrow(/timeout/i);
  });
});
