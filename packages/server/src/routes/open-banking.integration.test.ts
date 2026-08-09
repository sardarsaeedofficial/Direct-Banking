import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FakeBankDataProvider } from "../services/open-banking/fake-provider.js";
import type { ProviderTransaction } from "../services/open-banking/provider.js";

// Open Banking / reconciliation integration tests. Opt-in via MOBILE_TEST_DATABASE_URL,
// run with `--pool=forks`. No real TrueLayer credentials — a fake provider is used.

let ready = false;
let server: Server | undefined;
let base = "";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
let fake: FakeBankDataProvider;
let setProviderForTests: (p: unknown | null) => void;

const device = { deviceId: "ob-test-device-01", platform: "android" as const };

beforeAll(async () => {
  const dbUrl = process.env.MOBILE_TEST_DATABASE_URL;
  if (!dbUrl) return;
  process.env.DATABASE_URL = dbUrl;
  process.env.MOBILE_JWT_SECRET ||= "test-mobile-secret-0123456789abcdef";
  process.env.SESSION_SECRET ||= "test-session-secret-0123456789abcdef";
  process.env.COOKIE_SECURE ||= "false";
  process.env.OPEN_BANKING_ENABLED = "true";
  process.env.OPEN_BANKING_DATA_KEY = "0".repeat(64);
  try {
    prisma = (await import("../db.js")).prisma;
    await prisma.$queryRaw`SELECT 1`;
    const registry = await import("../services/open-banking/registry.js");
    setProviderForTests = registry.setProviderForTests as never;
    const { FakeBankDataProvider } = await import("../services/open-banking/fake-provider.js");
    fake = new FakeBankDataProvider();
    setProviderForTests(fake);
    server = (await import("../app.js")).createApp().listen(0);
    await new Promise((r) => server!.once("listening", r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api/mobile/v1`;
    ready = true;
  } catch {
    ready = false;
  }
});

afterAll(async () => {
  if (server) server.close();
  if (ready && prisma) await prisma.user.deleteMany({ where: { email: { contains: "obtest+" } } });
});

beforeEach(() => {
  if (!ready) return;
  fake.seedAccounts([]);
  fake.failMode = null;
});

async function newUser() {
  const email = `obtest+${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await fetch(base + "/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "password1234", device }) });
  const token = (await reg.json()).accessToken as string;
  const user = await prisma.user.findUnique({ where: { email } });
  return { userId: user.id as string, token };
}
function auth(token: string) { return { authorization: `Bearer ${token}` }; }
function post(token: string, path: string, body?: unknown) {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...auth(token) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> }));
}
function get(token: string, path: string) {
  return fetch(`${base}${path}`, { headers: auth(token) }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> }));
}
function del(token: string, path: string) {
  return fetch(`${base}${path}`, { method: "DELETE", headers: auth(token) }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> }));
}
function callback(state: string, code = "okcode") {
  return fetch(`${base}/bank-connections/callback?state=${encodeURIComponent(state)}&code=${code}`).then((r) => r.status);
}
function stateFrom(url: string): string { return new URL(url).searchParams.get("state") ?? ""; }

/** Start + authorize a connection; the callback triggers the initial import. */
async function connect(token: string): Promise<string> {
  const start = await post(token, "/bank-connections/start");
  const state = stateFrom(start.json.authorizationUrl);
  await callback(state);
  return start.json.connectionId as string;
}

const ptx = (over: Partial<ProviderTransaction> & { providerTransactionId: string; providerAccountId: string; amountMinor: number; direction: "INCOME" | "EXPENSE"; bookedAt: string }): ProviderTransaction => ({
  currency: "GBP", status: "SETTLED", ...over,
});

async function accountByProvider(userId: string, providerAccountId: string) {
  return prisma.bankAccount.findFirst({ where: { userId, providerAccountId } });
}
async function txnCount(userId: string, accountId: string) {
  return prisma.transaction.count({ where: { userId, accountId, parentId: null } });
}

describe("Open Banking — connections & reconciliation", () => {
  it("enforces ownership and rejects reused callback state", async (ctx) => {
    if (!ready) return ctx.skip();
    const a = await newUser();
    const b = await newUser();
    const start = await post(a.token, "/bank-connections/start");
    expect(start.status).toBe(201);
    const state = stateFrom(start.json.authorizationUrl);
    const id = start.json.connectionId as string;

    fake.seedAccounts([{ providerAccountId: "acc-x", currency: "GBP", institutionName: "Monzo", ownershipKey: "acc-x" }]);
    fake.seedBalance({ providerAccountId: "acc-x", currentMinor: 0, currency: "GBP" });

    expect(await callback(state)).toBe(200); // first use works
    expect(await callback(state)).toBe(400); // reused state rejected

    // b cannot see a's connection.
    expect((await get(b.token, `/bank-connections/${id}`)).status).toBe(404);
    expect((await post(b.token, `/bank-connections/${id}/sync`)).status).toBe(404);
    expect((await del(b.token, `/bank-connections/${id}`)).status).toBe(404);
    // a can.
    expect((await get(a.token, `/bank-connections/${id}`)).status).toBe(200);
  });

  it("imports accounts once, maps holder metadata, and makes the provider balance authoritative", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    fake.seedAccounts([{ providerAccountId: "acc-A", currency: "GBP", institutionName: "Monzo", displayName: "Monzo Current", accountHolderName: "Sardar Saeed", maskedAccountNumber: "••••6789", maskedSortCode: "••••04", ownershipKey: "acc-A" }]);
    fake.seedBalance({ providerAccountId: "acc-A", currentMinor: 100000, currency: "GBP" }); // £1,000 authoritative
    fake.seedTransactions("acc-A", [
      ptx({ providerTransactionId: "t-salary", providerAccountId: "acc-A", amountMinor: 200000, direction: "INCOME", bookedAt: "2026-06-01T09:00:00Z", merchantName: "ACME Payroll" }),
      ptx({ providerTransactionId: "t-tesco", providerAccountId: "acc-A", amountMinor: 5000, direction: "EXPENSE", bookedAt: "2026-06-02T09:00:00Z", merchantName: "Tesco" }),
      ptx({ providerTransactionId: "t-fuel", providerAccountId: "acc-A", amountMinor: 6000, direction: "EXPENSE", bookedAt: "2026-06-03T09:00:00Z", merchantName: "Shell" }),
    ]);
    const id = await connect(token);

    const detail = await get(token, `/bank-connections/${id}`);
    expect(detail.json.connection.status).toBe("ACTIVE");
    expect(detail.json.accounts.length).toBe(1);
    expect(detail.json.accounts[0].accountHolderName).toBe("Sardar Saeed");
    expect(detail.json.accounts[0].balanceAuthority).toBe("PROVIDER");

    const acc = await accountByProvider(userId, "acc-A");
    // £2,000 + (−£50) + (−£60) must NOT be added onto the authoritative balance.
    expect(acc.balanceMinor).toBe(100000n);
    expect(await txnCount(userId, acc.id)).toBe(3);

    // Re-sync is idempotent: no duplicate accounts or transactions, balance stays authoritative.
    await post(token, `/bank-connections/${id}/sync`);
    expect(await prisma.bankAccount.count({ where: { userId, providerAccountId: "acc-A" } })).toBe(1);
    expect(await txnCount(userId, acc.id)).toBe(3);
    expect((await accountByProvider(userId, "acc-A")).balanceMinor).toBe(100000n);
  });

  it("reconciles a notification and a provider record for the same payment into ONE transaction", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    // Manual Monzo account + a fast notification transaction.
    const manual = await prisma.bankAccount.create({ data: { userId, bankName: "Monzo", nickname: "Monzo", currency: "GBP", balanceMinor: 50000n } });
    await post(token, "/notification-imports/auto", {
      fingerprint: `n-${Date.now()}`, sourcePackage: "co.uk.getmondo", direction: "EXPENSE", amountMinor: 1830, currency: "GBP",
      occurredAt: "2026-06-15T10:04:00Z", confidence: 0.95, redactedSourceText: "Tesco", title: "Tesco", merchant: "Tesco", accountId: manual.id,
    });
    expect(await txnCount(userId, manual.id)).toBe(1);

    // Provider feed reports the same payment slightly later, with an authoritative descriptor.
    fake.seedAccounts([{ providerAccountId: "acc-A", currency: "GBP", institutionName: "Monzo", ownershipKey: "acc-A" }]);
    fake.seedBalance({ providerAccountId: "acc-A", currentMinor: 48170, currency: "GBP" });
    fake.seedTransactions("acc-A", [ptx({ providerTransactionId: "p-tesco", providerAccountId: "acc-A", amountMinor: 1830, direction: "EXPENSE", bookedAt: "2026-06-15T10:04:30Z", merchantName: "TESCO STORES" })]);
    await connect(token);

    // Still ONE transaction on the (now linked) account, enriched with provider evidence.
    const acc = await accountByProvider(userId, "acc-A");
    expect(acc.id).toBe(manual.id); // linked, not duplicated
    expect(await txnCount(userId, manual.id)).toBe(1);
    const ev = await prisma.transactionEvidence.count({ where: { transaction: { accountId: manual.id }, sourceType: "OPEN_BANKING" } });
    expect(ev).toBe(1);
  });

  it("creates a new canonical transaction when there was no notification", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    fake.seedAccounts([{ providerAccountId: "acc-A", currency: "GBP", institutionName: "Monzo", ownershipKey: "acc-A" }]);
    fake.seedBalance({ providerAccountId: "acc-A", currentMinor: 90000, currency: "GBP" });
    fake.seedTransactions("acc-A", [ptx({ providerTransactionId: "p-shell-nonotif", providerAccountId: "acc-A", amountMinor: 6500, direction: "EXPENSE", bookedAt: "2026-06-20T08:00:00Z", merchantName: "Shell" })]);
    await connect(token);
    const acc = await accountByProvider(userId, "acc-A");
    const rows = await prisma.transaction.findMany({ where: { userId, accountId: acc.id } });
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("OPEN_BANKING");
    expect(Number(rows[0].amountMinor)).toBe(6500);
  });

  it("does not reconcile unrelated same-amount transactions far apart in time", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    const manual = await prisma.bankAccount.create({ data: { userId, bankName: "Monzo", nickname: "Monzo", currency: "GBP", balanceMinor: 100000n } });
    await post(token, "/notification-imports/auto", {
      fingerprint: `n2-${Date.now()}`, sourcePackage: "co.uk.getmondo", direction: "EXPENSE", amountMinor: 2000, currency: "GBP",
      occurredAt: "2026-06-01T10:00:00Z", confidence: 0.95, redactedSourceText: "Tesco", title: "Tesco", merchant: "Tesco", accountId: manual.id,
    });
    fake.seedAccounts([{ providerAccountId: "acc-A", currency: "GBP", institutionName: "Monzo", ownershipKey: "acc-A" }]);
    fake.seedBalance({ providerAccountId: "acc-A", currentMinor: 96000, currency: "GBP" });
    // Same £20 but an unrelated merchant, 12 days later → outside the match window.
    fake.seedTransactions("acc-A", [ptx({ providerTransactionId: "p-amz", providerAccountId: "acc-A", amountMinor: 2000, direction: "EXPENSE", bookedAt: "2026-06-13T10:00:00Z", merchantName: "Amazon" })]);
    await connect(token);
    const acc = await accountByProvider(userId, "acc-A");
    expect(await txnCount(userId, acc.id)).toBe(2); // two distinct transactions, not merged
  });

  it("updates a pending transaction to settled without creating a duplicate", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    fake.seedAccounts([{ providerAccountId: "acc-A", currency: "GBP", institutionName: "Monzo", ownershipKey: "acc-A" }]);
    fake.seedBalance({ providerAccountId: "acc-A", currentMinor: 99700, currency: "GBP" });
    fake.seedTransactions("acc-A", [ptx({ providerTransactionId: "p-coffee", providerAccountId: "acc-A", amountMinor: 300, direction: "EXPENSE", bookedAt: "2026-06-21T08:00:00Z", status: "PENDING", merchantName: "Cafe" })]);
    const id = await connect(token);
    const acc = await accountByProvider(userId, "acc-A");
    expect(await txnCount(userId, acc.id)).toBe(1);

    // Same provider id now settled → update in place.
    fake.seedTransactions("acc-A", [ptx({ providerTransactionId: "p-coffee", providerAccountId: "acc-A", amountMinor: 300, direction: "EXPENSE", bookedAt: "2026-06-21T08:00:00Z", status: "SETTLED", merchantName: "Cafe" })]);
    await post(token, `/bank-connections/${id}/sync`);
    expect(await txnCount(userId, acc.id)).toBe(1);
    const row = await prisma.transaction.findFirst({ where: { userId, accountId: acc.id } });
    expect(row.status).toBe("COMPLETED");
  });

  it("pairs an own-account transfer across two connected accounts using strong account evidence", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    fake.seedAccounts([
      { providerAccountId: "acc-A", currency: "GBP", institutionName: "Monzo", accountHolderName: "Sardar Saeed", ownershipKey: "acc-A" },
      { providerAccountId: "acc-B", currency: "GBP", institutionName: "Revolut", accountHolderName: "Sardar Saeed", ownershipKey: "acc-B" },
    ]);
    fake.seedBalance({ providerAccountId: "acc-A", currentMinor: 40000, currency: "GBP" });
    fake.seedBalance({ providerAccountId: "acc-B", currentMinor: 60000, currency: "GBP" });
    const when = "2026-06-10T12:00:00Z";
    fake.seedTransactions("acc-A", [ptx({ providerTransactionId: "p-out", providerAccountId: "acc-A", amountMinor: 10000, direction: "EXPENSE", bookedAt: when, merchantName: "Savings Transfer" })]);
    fake.seedTransactions("acc-B", [ptx({ providerTransactionId: "p-in", providerAccountId: "acc-B", amountMinor: 10000, direction: "INCOME", bookedAt: when, merchantName: "Savings Transfer" })]);
    await connect(token);

    const a = await accountByProvider(userId, "acc-A");
    const b = await accountByProvider(userId, "acc-B");
    const ta = await prisma.transaction.findFirst({ where: { userId, accountId: a.id } });
    const tb = await prisma.transaction.findFirst({ where: { userId, accountId: b.id } });
    expect(ta.transactionType).toBe("INTERNAL_TRANSFER");
    expect(tb.transactionType).toBe("INTERNAL_TRANSFER");
    expect(ta.internalTransferGroupId).toBe(tb.internalTransferGroupId);
  });

  it("links a provider Direct Debit to a Phase 2 mandate", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    fake.seedAccounts([{ providerAccountId: "acc-A", currency: "GBP", institutionName: "Monzo", ownershipKey: "acc-A" }]);
    fake.seedBalance({ providerAccountId: "acc-A", currentMinor: 91800, currency: "GBP" });
    fake.seedTransactions("acc-A", [ptx({ providerTransactionId: "p-bg", providerAccountId: "acc-A", amountMinor: 8200, direction: "EXPENSE", bookedAt: "2026-06-15T06:00:00Z", merchantName: "British Gas", isDirectDebit: true })]);
    await connect(token);
    const acc = await accountByProvider(userId, "acc-A");
    const row = await prisma.transaction.findFirst({ where: { userId, accountId: acc.id } });
    expect(row.transactionType).toBe("DIRECT_DEBIT");
    expect(row.directDebitMandateId).toBeTruthy();
    expect(await prisma.directDebitMandate.count({ where: { userId } })).toBe(1);
  });

  it("keeps existing data and records an error when a provider sync fails", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    fake.seedAccounts([{ providerAccountId: "acc-A", currency: "GBP", institutionName: "Monzo", ownershipKey: "acc-A" }]);
    fake.seedBalance({ providerAccountId: "acc-A", currentMinor: 90000, currency: "GBP" });
    fake.seedTransactions("acc-A", [ptx({ providerTransactionId: "p-shell-fail", providerAccountId: "acc-A", amountMinor: 6500, direction: "EXPENSE", bookedAt: "2026-06-20T08:00:00Z", merchantName: "Shell" })]);
    const id = await connect(token);
    const acc = await accountByProvider(userId, "acc-A");
    expect(await txnCount(userId, acc.id)).toBe(1);

    // Now the provider is unavailable.
    fake.failMode = "txns";
    const res = await post(token, `/bank-connections/${id}/sync`);
    expect(res.status).toBe(502);
    expect(await txnCount(userId, acc.id)).toBe(1); // previous data preserved
    const detail = await get(token, `/bank-connections/${id}`);
    expect(detail.json.connection.lastErrorCode).toBe("SYNC_FAILED");
  });

  it("stops sync on a revoked connection but keeps history", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    fake.seedAccounts([{ providerAccountId: "acc-A", currency: "GBP", institutionName: "Monzo", ownershipKey: "acc-A" }]);
    fake.seedBalance({ providerAccountId: "acc-A", currentMinor: 90000, currency: "GBP" });
    fake.seedTransactions("acc-A", [ptx({ providerTransactionId: "p-shell-revoke", providerAccountId: "acc-A", amountMinor: 6500, direction: "EXPENSE", bookedAt: "2026-06-20T08:00:00Z", merchantName: "Shell" })]);
    const id = await connect(token);
    const acc = await accountByProvider(userId, "acc-A");

    expect((await del(token, `/bank-connections/${id}`)).json.revoked).toBe(true);
    const detail = await get(token, `/bank-connections/${id}`);
    expect(detail.json.connection.status).toBe("REVOKED");
    expect((await post(token, `/bank-connections/${id}/sync`)).status).toBe(502); // cannot sync
    expect(await txnCount(userId, acc.id)).toBe(1); // history preserved
  });

  it("stores provider connection material only as ciphertext", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    fake.seedAccounts([{ providerAccountId: "acc-A", currency: "GBP", institutionName: "Monzo", ownershipKey: "acc-A" }]);
    fake.seedBalance({ providerAccountId: "acc-A", currentMinor: 0, currency: "GBP" });
    await connect(token);
    const conn = await prisma.bankConnection.findFirst({ where: { userId } });
    expect(conn.providerConnectionIdEncrypted).toBeTruthy();
    expect(conn.providerConnectionIdEncrypted).toContain("v1.");
    expect(conn.providerConnectionIdEncrypted).not.toContain("fake-access");
    expect(conn.providerConnectionIdEncrypted).not.toContain("fake-refresh");
  });
});
