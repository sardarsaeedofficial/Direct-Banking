import { afterEach, describe, expect, it, vi } from "vitest";
import { TrueLayerDataV3Provider, ReauthRequiredError } from "./truelayer-provider.js";

// Contract tests for the REAL Data v3 HTTP adapter, exercised against mocked v3
// fixtures (no TrueLayer credentials). These prove request shape, headers,
// pagination and error handling of TrueLayerDataV3Provider itself.

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

/** Install a fetch mock that routes by URL, tracking a per-URL call counter. */
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
function withToken(url: string, onData: (url: string, init: RequestInit, n: number) => Response | Promise<Response>) {
  return (u: string, init: RequestInit, n: number) => (u.endsWith("/connect/token") ? res(200, tokenBody) : onData(u, init, n));
}

afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

describe("TrueLayerDataV3Provider (Data v3 contract)", () => {
  it("uses a client-credentials data token and creates a data-connection", async () => {
    mockFetch(withToken("", (u) => res(200, { id: "conn-1", authorization_uri: "https://auth.tl/hosted?x=1" })));
    const p = new TrueLayerDataV3Provider(cfg);
    const out = await p.createConnection({ userId: "u", connectionId: "c", state: "NONCE", returnUri: cfg.returnUri });
    expect(out.providerConnectionId).toBe("conn-1");
    expect(out.authorizationUrl).toBe("https://auth.tl/hosted?x=1");

    const token = calls.find((c) => c.url.endsWith("/connect/token"))!;
    expect(String(token.init.body)).toContain("grant_type=client_credentials");
    expect(String(token.init.body)).toContain("scope=data");
    const create = calls.find((c) => c.url.endsWith("/v3/data-connections"))!;
    expect(create.init.method).toBe("POST");
    expect(String(create.init.body)).toContain("?state=NONCE"); // our nonce rides our return URI
    expect(String(create.init.body)).toContain("accounts");
    // No Data v1 anywhere.
    expect(calls.every((c) => !c.url.includes("/data/v1/"))).toBe(true);
  });

  it("lists connected accounts with the Connection-Id header and masks identifiers", async () => {
    mockFetch(withToken("", () => res(200, {
      results: [{
        account_id: "a1", account_type: "TRANSACTION", display_name: "Current", currency: "GBP",
        account_holder_name: "Sardar Saeed",
        account_identifiers: [{ type: "sort_code_account_number", account_number: "12345678", sort_code: "040004" }, { type: "iban", iban: "GB00BANK12345678" }],
        provider: { display_name: "Monzo", provider_id: "monzo" },
      }],
    })));
    const p = new TrueLayerDataV3Provider(cfg);
    const accounts = await p.listAccounts(secret);
    const call = calls.find((c) => c.url.endsWith("/v3/connected-accounts"))!;
    expect(call.url).toBe("https://api.tl/v3/connected-accounts");
    expect((call.init.headers as Record<string, string>)["Connection-Id"]).toBe("conn-1");
    expect(accounts[0].maskedAccountNumber).toBe("••••5678");
    expect(accounts[0].maskedIban).toContain("••••");
    expect(accounts[0].accountHolderName).toBe("Sardar Saeed");
    expect(accounts[0].maskedAccountNumber).not.toContain("12345678");
  });

  it("reads a balance from the v3 connected-account endpoint", async () => {
    mockFetch(withToken("", () => res(200, { results: [{ currency: "GBP", current: 1000.5, available: 900.25 }] })));
    const p = new TrueLayerDataV3Provider(cfg);
    const b = await p.getBalances(secret, "a1");
    expect(calls.find((c) => c.url.includes("/v3/connected-accounts/a1/balance"))).toBeTruthy();
    expect(b.currentMinor).toBe(100050);
    expect(b.availableMinor).toBe(90025);
  });

  it("pages transactions via the cursor until exhausted", async () => {
    mockFetch(withToken("", (u) => {
      const page2 = u.includes("cursor=CUR2");
      if (page2) return res(200, { results: [{ transaction_id: "t2", timestamp: "2026-06-02T09:00:00Z", amount: 2000, currency: "GBP", transaction_type: "CREDIT", description: "SALARY" }] });
      return res(200, { results: [{ transaction_id: "t1", timestamp: "2026-06-01T09:00:00Z", amount: -50, currency: "GBP", transaction_type: "DEBIT", merchant_name: "Tesco" }], next_cursor: "CUR2" });
    }));
    const p = new TrueLayerDataV3Provider(cfg);
    const txns = await p.getTransactions(secret, "a1", { fromIso: "2026-01-01T00:00:00Z" });
    expect(txns.map((t) => t.providerTransactionId)).toEqual(["t1", "t2"]);
    expect(txns[0].direction).toBe("EXPENSE");
    expect(txns[1].direction).toBe("INCOME");
    expect(calls.some((c) => c.url.includes("cursor=CUR2"))).toBe(true);
  });

  it("refreshes the token and retries once on 401", async () => {
    mockFetch(withToken("", (u, _i, n) => (n === 1 ? res(401, {}) : res(200, { results: [] }))));
    const p = new TrueLayerDataV3Provider(cfg);
    await p.listAccounts(secret);
    expect(calls.filter((c) => c.url.endsWith("/connect/token")).length).toBe(2); // refreshed
    expect(calls.filter((c) => c.url.endsWith("/v3/connected-accounts")).length).toBe(2); // retried
  });

  it("maps 403 to a reauthorization-required error", async () => {
    mockFetch(withToken("", () => res(403, {})));
    const p = new TrueLayerDataV3Provider(cfg);
    await expect(p.listAccounts(secret)).rejects.toBeInstanceOf(ReauthRequiredError);
    // getConnectionStatus turns it into a lifecycle state.
    mockFetch(withToken("", () => res(403, {})));
    expect(await p.getConnectionStatus(secret)).toBe("REAUTH_REQUIRED");
  });

  it("retries on 429 and then succeeds", async () => {
    mockFetch(withToken("", (u, _i, n) => (n === 1 ? res(429, {}, { "retry-after": "0" }) : res(200, { results: [] }))));
    const p = new TrueLayerDataV3Provider(cfg);
    await p.listAccounts(secret);
    expect(calls.filter((c) => c.url.endsWith("/v3/connected-accounts")).length).toBe(2);
  });

  it("fails after exhausting retries on 5xx", async () => {
    mockFetch(withToken("", () => res(503, {})));
    const p = new TrueLayerDataV3Provider(cfg);
    await expect(p.listAccounts(secret)).rejects.toThrow(/failed/i);
    expect(calls.filter((c) => c.url.endsWith("/v3/connected-accounts")).length).toBe(3); // initial + 2 retries
  });

  it("rejects a malformed provider response", async () => {
    mockFetch(withToken("", () => res(200, MALFORMED)));
    const p = new TrueLayerDataV3Provider(cfg);
    await expect(p.listAccounts(secret)).rejects.toThrow(/malformed/i);
  });

  it("surfaces a timeout as a sanitised error", async () => {
    mockFetch(withToken("", () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; }));
    const p = new TrueLayerDataV3Provider(cfg);
    await expect(p.listAccounts(secret)).rejects.toThrow(/timeout/i);
  });
});
