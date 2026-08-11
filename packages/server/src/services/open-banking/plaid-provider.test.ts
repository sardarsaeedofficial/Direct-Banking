import { createHash, generateKeyPairSync, sign as ecSign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaidProvider, ReauthRequiredError, SyncMutationError } from "./plaid-provider.js";

// Contract tests for the REAL Plaid HTTP adapter, exercised against mocked fixtures
// that mirror the official Plaid API shapes. No Plaid credentials required.

const cfg = { clientId: "cid", secret: "csecret", apiBase: "https://plaid.test", countryCodes: ["GB"], recurringEnabled: false, webhookUri: "https://app/webhook", androidPackageName: "uk.co.prisom.directbanking" };
const secret = { providerConnectionId: "access-1" };
const MALFORMED = Symbol("malformed");
interface Recorded { url: string; body: Record<string, unknown> }
const calls: Recorded[] = [];

function res(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => { if (body === MALFORMED) throw new Error("bad"); return body; } } as unknown as Response;
}
function mockFetch(handler: (path: string, body: Record<string, unknown>, n: number) => Response | Promise<Response>) {
  const counts = new Map<string, number>();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const path = url.replace(cfg.apiBase, "");
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    const n = (counts.get(path) ?? 0) + 1;
    counts.set(path, n);
    return handler(path, body, n);
  }));
}
afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; });

describe("PlaidProvider (contract)", () => {
  it("reports full transaction capabilities", () => {
    const caps = new PlaidProvider(cfg).capabilities();
    expect(caps.has("ACCOUNTS")).toBe(true);
    expect(caps.has("BALANCES")).toBe(true);
    expect(caps.has("TRANSACTIONS")).toBe(true);
  });

  it("creates a Link token with the transactions product and returns a link_token", async () => {
    mockFetch(() => res(200, { link_token: "link-sandbox-abc", expiration: "2026-01-01T00:00:00Z" }));
    const out = await new PlaidProvider(cfg).createConnection({ userId: "u1", connectionId: "c1", state: "s", returnUri: "https://app/cb" });
    expect(out).toEqual({ mode: "link_token", linkToken: "link-sandbox-abc" });
    const call = calls.find((c) => c.url.endsWith("/link/token/create"))!;
    expect(call.body.client_id).toBe("cid");
    expect(call.body.products).toEqual(["transactions"]);
    expect((call.body.user as { client_user_id: string }).client_user_id).toBe("u1");
    expect(call.body.webhook).toBe("https://app/webhook");
    // Native Android: package name is sent; no redirect_uri.
    expect(call.body.android_package_name).toBe("uk.co.prisom.directbanking");
    expect(call.body.redirect_uri).toBeUndefined();
  });

  it("exchanges a public token for an access token + item id (never logged)", async () => {
    mockFetch(() => res(200, { access_token: "access-xyz", item_id: "item-xyz" }));
    const out = await new PlaidProvider(cfg).exchangePublicToken("public-123");
    expect(out.secret.providerConnectionId).toBe("access-xyz");
    expect(out.providerItemId).toBe("item-xyz");
    expect(calls[0].body.public_token).toBe("public-123");
  });

  it("imports accounts with cached balances and masked numbers", async () => {
    mockFetch(() => res(200, { accounts: [{ account_id: "a1", name: "Everyday", official_name: "Current Account", type: "depository", subtype: "checking", mask: "6789", balances: { current: 1000.5, available: 900.25, iso_currency_code: "GBP" } }], item: { institution_id: "ins_1" } }));
    const accounts = await new PlaidProvider(cfg).listAccounts(secret);
    expect(accounts[0].providerAccountId).toBe("a1");
    expect(accounts[0].accountType).toBe("checking");
    expect(accounts[0].maskedAccountNumber).toBe("••6789"); // Plaid mask is already the trailing digits
    expect(accounts[0].cachedBalanceMinor).toBe(100050);
    expect(accounts[0].cachedAvailableMinor).toBe(90025);
  });

  it("reads a fresh balance from /accounts/balance/get", async () => {
    mockFetch(() => res(200, { accounts: [{ account_id: "a1", balances: { current: 250.75, available: 200, iso_currency_code: "GBP" } }] }));
    const b = await new PlaidProvider(cfg).getBalances(secret, "a1");
    expect(b.currentMinor).toBe(25075);
    expect(calls[0].url).toContain("/accounts/balance/get");
  });

  it("maps /transactions/sync with Plaid's sign convention and lifecycle fields", async () => {
    mockFetch(() => res(200, {
      added: [
        { transaction_id: "t1", account_id: "a1", amount: 18.3, iso_currency_code: "GBP", date: "2026-06-15", name: "TESCO", merchant_name: "Tesco", pending: false },
        { transaction_id: "t2", account_id: "a1", amount: -2000, iso_currency_code: "GBP", date: "2026-06-01", name: "SALARY", pending: false },
        { transaction_id: "t3", account_id: "a1", amount: 3, iso_currency_code: "GBP", date: "2026-06-20", name: "Coffee", pending: true, pending_transaction_id: null },
      ],
      modified: [], removed: [{ transaction_id: "t0", account_id: "a1" }], next_cursor: "CUR", has_more: false,
    }));
    const page = await new PlaidProvider(cfg).syncTransactions(secret, null);
    expect(page.added[0].direction).toBe("EXPENSE"); // Plaid positive amount = money out
    expect(page.added[0].amountMinor).toBe(1830);
    expect(page.added[1].direction).toBe("INCOME"); // negative = money in
    expect(page.added[2].status).toBe("PENDING");
    expect(page.removed).toEqual(["t0"]);
    expect(page.nextCursor).toBe("CUR");
    expect(page.hasMore).toBe(false);
    expect(calls[0].body.access_token).toBe("access-1");
  });

  it("paginates via has_more/next_cursor", async () => {
    mockFetch((_p, body, n) => n === 1
      ? res(200, { added: [{ transaction_id: "t1", account_id: "a1", amount: 5, date: "2026-06-01" }], modified: [], removed: [], next_cursor: "C2", has_more: true })
      : res(200, { added: [{ transaction_id: "t2", account_id: "a1", amount: 6, date: "2026-06-02" }], modified: [], removed: [], next_cursor: "C3", has_more: false }));
    const p = new PlaidProvider(cfg);
    const first = await p.syncTransactions(secret, null);
    expect(first.hasMore).toBe(true);
    const second = await p.syncTransactions(secret, first.nextCursor);
    expect(second.hasMore).toBe(false);
    expect(calls[1].body.cursor).toBe("C2");
  });

  it("raises SyncMutationError on a mid-pagination mutation", async () => {
    mockFetch(() => res(400, { error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" }));
    await expect(new PlaidProvider(cfg).syncTransactions(secret, "C2")).rejects.toBeInstanceOf(SyncMutationError);
  });

  it("maps ITEM_LOGIN_REQUIRED to reauthorization", async () => {
    mockFetch(() => res(400, { error_code: "ITEM_LOGIN_REQUIRED" }));
    await expect(new PlaidProvider(cfg).listAccounts(secret)).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  it("rejects a malformed response", async () => {
    mockFetch(() => res(200, MALFORMED));
    await expect(new PlaidProvider(cfg).listAccounts(secret)).rejects.toThrow(/malformed/i);
  });

  it("verifies a genuine Plaid webhook JWT and rejects a tampered body", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const rawBody = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-1" });
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const header = enc({ alg: "ES256", kid: "key-1", typ: "JWT" });
    const payload = enc({ iat: Math.floor(Date.now() / 1000), request_body_sha256: createHash("sha256").update(rawBody).digest("hex") });
    const sig = ecSign("sha256", Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    const jwt = `${header}.${payload}.${sig}`;

    mockFetch(() => res(200, { key: jwk }));
    const p = new PlaidProvider(cfg);
    expect(await p.verifyWebhook(rawBody, jwt)).toBe(true);
    expect(await p.verifyWebhook(rawBody + "tampered", jwt)).toBe(false);
  });
});
