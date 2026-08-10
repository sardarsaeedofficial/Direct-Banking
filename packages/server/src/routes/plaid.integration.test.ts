import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FakePlaidProvider } from "../services/open-banking/fake-plaid-provider.js";
import type { ProviderTransaction } from "../services/open-banking/provider.js";

// Plaid provider integration tests. Opt-in via MOBILE_TEST_DATABASE_URL, run with
// `--pool=forks`. Uses a fake Plaid provider — no Plaid credentials required.

let ready = false;
let server: Server | undefined;
let base = "";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
let fake: FakePlaidProvider;

const device = { deviceId: "plaid-test-device-01", platform: "android" as const };

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
    const { FakePlaidProvider } = await import("../services/open-banking/fake-plaid-provider.js");
    fake = new FakePlaidProvider();
    registry.setProviderForTests(fake);
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
  if (ready && prisma) await prisma.user.deleteMany({ where: { email: { contains: "plaidtest+" } } });
});

beforeEach(() => {
  if (!ready) return;
  fake.seedAccounts([]);
  fake.seedSyncPages([]);
  fake.failMode = null;
  fake.failMutationOnce = false;
  fake.setResolveState("ACTIVE");
});

async function newUser() {
  const email = `plaidtest+${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await fetch(base + "/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "password1234", device }) });
  const token = (await reg.json()).accessToken as string;
  const user = await prisma.user.findUnique({ where: { email } });
  return { userId: user.id as string, token };
}
function auth(t: string) { return { authorization: `Bearer ${t}` }; }
function post(t: string, path: string, body?: unknown) {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...auth(t) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> }));
}
function get(t: string, path: string) {
  return fetch(`${base}${path}`, { headers: auth(t) }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> }));
}
function del(t: string, path: string) {
  return fetch(`${base}${path}`, { method: "DELETE", headers: auth(t) }).then((r) => ({ status: r.status }));
}
function webhook(itemId: string, code: string) {
  return fetch(`${base}/bank-connections/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: code, item_id: itemId }) }).then((r) => r.status);
}

const ptx = (over: Partial<ProviderTransaction> & { providerTransactionId: string; providerAccountId: string; amountMinor: number; direction: "INCOME" | "EXPENSE"; bookedAt: string }): ProviderTransaction => ({
  currency: "GBP", status: "SETTLED", ...over,
});

/** Start + complete a Plaid connection; the complete triggers the initial sync. */
async function connectPlaid(token: string, publicToken: string): Promise<{ connectionId: string; itemId: string }> {
  const start = await post(token, "/bank-connections/start");
  const connectionId = start.json.connectionId as string;
  await post(token, `/bank-connections/${connectionId}/complete`, { publicToken });
  return { connectionId, itemId: `item-${publicToken}` };
}
async function accountByProvider(userId: string, providerAccountId: string) {
  return prisma.bankAccount.findFirst({ where: { userId, providerAccountId } });
}

describe("Plaid provider — connections, sync & reconciliation", () => {
  it("creates a link token, exchanges a public token, imports accounts and makes the balance authoritative", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    const start = await post(token, "/bank-connections/start");
    expect(start.json.mode).toBe("link_token");
    expect(start.json.linkToken).toContain("link-");

    fake.seedAccounts([{ providerAccountId: "a1", currency: "GBP", institutionName: "Monzo", displayName: "Monzo Current", cachedBalanceMinor: 100000 }]);
    fake.seedSyncPages([{ added: [
      ptx({ providerTransactionId: "t-sal", providerAccountId: "a1", amountMinor: 200000, direction: "INCOME", bookedAt: "2026-06-01T09:00:00Z", merchantName: "Payroll" }),
      ptx({ providerTransactionId: "t-tsc", providerAccountId: "a1", amountMinor: 5000, direction: "EXPENSE", bookedAt: "2026-06-02T09:00:00Z", merchantName: "Tesco" }),
      ptx({ providerTransactionId: "t-fue", providerAccountId: "a1", amountMinor: 6000, direction: "EXPENSE", bookedAt: "2026-06-03T09:00:00Z", merchantName: "Shell" }),
    ] }]);
    const cid = start.json.connectionId as string;
    const done = await post(token, `/bank-connections/${cid}/complete`, { publicToken: "pub-1" });
    expect(done.status).toBe(200);

    const detail = await get(token, `/bank-connections/${cid}`);
    expect(detail.json.connection.status).toBe("ACTIVE");
    const acc = await accountByProvider(userId, "a1");
    expect(acc.balanceMinor).toBe(100000n); // provider-authoritative, history not summed
    expect(await prisma.transaction.count({ where: { userId, accountId: acc.id } })).toBe(3);
    // Cursor persisted for incremental sync.
    const conn = await prisma.bankConnection.findUnique({ where: { id: cid } });
    expect(conn.syncCursor).toBeTruthy();
    expect(conn.providerItemId).toBe("item-pub-1");
  });

  it("paginates initial history and is idempotent on repeated sync + duplicate webhook", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    fake.seedAccounts([{ providerAccountId: "a1", currency: "GBP", institutionName: "Monzo", cachedBalanceMinor: 50000 }]);
    fake.seedSyncPages([
      { added: [ptx({ providerTransactionId: "p1", providerAccountId: "a1", amountMinor: 1000, direction: "EXPENSE", bookedAt: "2026-06-01T09:00:00Z", merchantName: "A" })] },
      { added: [ptx({ providerTransactionId: "p2", providerAccountId: "a1", amountMinor: 2000, direction: "EXPENSE", bookedAt: "2026-06-02T09:00:00Z", merchantName: "B" })] },
    ]);
    const { connectionId, itemId } = await connectPlaid(token, "pub-2");
    const acc = await accountByProvider(userId, "a1");
    expect(await prisma.transaction.count({ where: { userId, accountId: acc.id } })).toBe(2); // both pages

    await post(token, `/bank-connections/${connectionId}/sync`); // repeated sync
    expect(await webhook(itemId, "SYNC_UPDATES_AVAILABLE")).toBe(200);
    expect(await webhook(itemId, "SYNC_UPDATES_AVAILABLE")).toBe(200); // duplicate delivery
    expect(await prisma.transaction.count({ where: { userId, accountId: acc.id } })).toBe(2); // no duplicates
  });

  it("recovers from a mid-pagination mutation by restarting the batch", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    fake.seedAccounts([{ providerAccountId: "a1", currency: "GBP", institutionName: "Monzo", cachedBalanceMinor: 9000 }]);
    fake.seedSyncPages([{ added: [ptx({ providerTransactionId: "m1", providerAccountId: "a1", amountMinor: 1000, direction: "EXPENSE", bookedAt: "2026-06-01T09:00:00Z", merchantName: "A" })] }]);
    fake.failMutationOnce = true; // first sync call throws, loop restarts
    const { connectionId } = await connectPlaid(token, "pub-mut");
    const acc = await accountByProvider(userId, "a1");
    expect(await prisma.transaction.count({ where: { userId, accountId: acc.id } })).toBe(1);
    expect((await prisma.bankConnection.findUnique({ where: { id: connectionId } })).syncCursor).toBeTruthy();
  });

  it("updates a modified transaction and reverses a removed one without erasing history", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    fake.seedAccounts([{ providerAccountId: "a1", currency: "GBP", institutionName: "Monzo", cachedBalanceMinor: 9000 }]);
    fake.seedSyncPages([{ added: [ptx({ providerTransactionId: "x1", providerAccountId: "a1", amountMinor: 1500, direction: "EXPENSE", bookedAt: "2026-06-01T09:00:00Z", merchantName: "Cafe" })] }]);
    const { connectionId } = await connectPlaid(token, "pub-mod");
    const acc = await accountByProvider(userId, "a1");

    // A later sync modifies x1 and removes it? No — modify then a separate removal target.
    fake.pushSyncPage({ modified: [ptx({ providerTransactionId: "x1", providerAccountId: "a1", amountMinor: 1500, direction: "EXPENSE", bookedAt: "2026-06-01T09:00:00Z", merchantName: "Coffee House" })] });
    await post(token, `/bank-connections/${connectionId}/sync`);
    const modified = await prisma.transaction.findFirst({ where: { userId, accountId: acc.id } });
    expect(modified.merchantName).toBe("Coffee House"); // enriched, not duplicated
    expect(await prisma.transaction.count({ where: { userId, accountId: acc.id } })).toBe(1);

    fake.pushSyncPage({ removed: ["x1"] });
    await post(token, `/bank-connections/${connectionId}/sync`);
    const removed = await prisma.transaction.findFirst({ where: { userId, accountId: acc.id } });
    expect(removed.status).toBe("CANCELLED"); // reversed, row preserved
    expect(await prisma.transaction.count({ where: { userId, accountId: acc.id } })).toBe(1);
  });

  it("converges a Plaid pending→settled pair into one transaction", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    fake.seedAccounts([{ providerAccountId: "a1", currency: "GBP", institutionName: "Monzo", cachedBalanceMinor: 9700 }]);
    fake.seedSyncPages([{ added: [ptx({ providerTransactionId: "pend1", providerAccountId: "a1", amountMinor: 300, direction: "EXPENSE", status: "PENDING", bookedAt: "2026-06-21T08:00:00Z", merchantName: "Cafe" })] }]);
    const { connectionId } = await connectPlaid(token, "pub-ps");
    const acc = await accountByProvider(userId, "a1");
    expect((await prisma.transaction.findFirst({ where: { userId, accountId: acc.id } })).status).toBe("PENDING");

    // Plaid settles: removes the pending id and adds a new settled id referencing it.
    fake.pushSyncPage({
      added: [ptx({ providerTransactionId: "settled1", providerAccountId: "a1", amountMinor: 300, direction: "EXPENSE", status: "SETTLED", bookedAt: "2026-06-21T08:00:00Z", merchantName: "Cafe", pendingTransactionId: "pend1" })],
      removed: ["pend1"],
    });
    await post(token, `/bank-connections/${connectionId}/sync`);
    expect(await prisma.transaction.count({ where: { userId, accountId: acc.id } })).toBe(1); // one row
    expect((await prisma.transaction.findFirst({ where: { userId, accountId: acc.id } })).status).toBe("COMPLETED");
  });

  it("reconciles a notification and a Plaid transaction into one canonical transaction", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    const manual = await prisma.bankAccount.create({ data: { userId, bankName: "Monzo", nickname: "Monzo", currency: "GBP", balanceMinor: 50000n } });
    await post(token, "/notification-imports/auto", {
      fingerprint: `pn-${Date.now()}`, sourcePackage: "co.uk.getmondo", direction: "EXPENSE", amountMinor: 1830, currency: "GBP",
      occurredAt: "2026-06-15T10:04:00Z", confidence: 0.95, redactedSourceText: "Tesco", title: "Tesco", merchant: "Tesco", accountId: manual.id,
    });
    fake.seedAccounts([{ providerAccountId: "a1", currency: "GBP", institutionName: "Monzo", cachedBalanceMinor: 48170 }]);
    fake.seedSyncPages([{ added: [ptx({ providerTransactionId: "pl-tsc", providerAccountId: "a1", amountMinor: 1830, direction: "EXPENSE", bookedAt: "2026-06-15T10:04:30Z", merchantName: "TESCO STORES" })] }]);
    await connectPlaid(token, "pub-rec");

    const acc = await accountByProvider(userId, "a1");
    expect(acc.id).toBe(manual.id); // linked, not duplicated
    expect(await prisma.transaction.count({ where: { userId, accountId: manual.id } })).toBe(1);
  });

  it("creates a canonical transaction from Plaid when there was no notification", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    fake.seedAccounts([{ providerAccountId: "a1", currency: "GBP", institutionName: "Monzo", cachedBalanceMinor: 90000 }]);
    fake.seedSyncPages([{ added: [ptx({ providerTransactionId: "pl-shell", providerAccountId: "a1", amountMinor: 6500, direction: "EXPENSE", bookedAt: "2026-06-20T08:00:00Z", merchantName: "Shell" })] }]);
    await connectPlaid(token, "pub-new");
    const acc = await accountByProvider(userId, "a1");
    const rows = await prisma.transaction.findMany({ where: { userId, accountId: acc.id } });
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("OPEN_BANKING");
  });

  it("pairs an own-account transfer across two Plaid accounts as an internal transfer", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    fake.seedAccounts([
      { providerAccountId: "a1", currency: "GBP", institutionName: "Monzo", cachedBalanceMinor: 40000 },
      { providerAccountId: "a2", currency: "GBP", institutionName: "Revolut", cachedBalanceMinor: 60000 },
    ]);
    const when = "2026-06-10T12:00:00Z";
    fake.seedSyncPages([{ added: [
      ptx({ providerTransactionId: "out", providerAccountId: "a1", amountMinor: 10000, direction: "EXPENSE", bookedAt: when, merchantName: "Transfer" }),
      ptx({ providerTransactionId: "in", providerAccountId: "a2", amountMinor: 10000, direction: "INCOME", bookedAt: when, merchantName: "Transfer" }),
    ] }]);
    await connectPlaid(token, "pub-xfer");
    const a = await accountByProvider(userId, "a1");
    const b = await accountByProvider(userId, "a2");
    const ta = await prisma.transaction.findFirst({ where: { userId, accountId: a.id } });
    const tb = await prisma.transaction.findFirst({ where: { userId, accountId: b.id } });
    expect(ta.transactionType).toBe("INTERNAL_TRANSFER");
    expect(tb.transactionType).toBe("INTERNAL_TRANSFER");
    expect(ta.internalTransferGroupId).toBe(tb.internalTransferGroupId);
  });

  it("feeds a Plaid Direct-Debit-like payment into the Phase 2 mandate engine", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    fake.seedAccounts([{ providerAccountId: "a1", currency: "GBP", institutionName: "Monzo", cachedBalanceMinor: 91800 }]);
    fake.seedSyncPages([{ added: [ptx({ providerTransactionId: "pl-bg", providerAccountId: "a1", amountMinor: 8200, direction: "EXPENSE", bookedAt: "2026-06-15T06:00:00Z", merchantName: "British Gas", description: "British Gas Direct Debit", isDirectDebit: true })] }]);
    await connectPlaid(token, "pub-dd");
    const acc = await accountByProvider(userId, "a1");
    const row = await prisma.transaction.findFirst({ where: { userId, accountId: acc.id } });
    expect(row.transactionType).toBe("DIRECT_DEBIT");
    expect(row.directDebitMandateId).toBeTruthy();
    expect(await prisma.directDebitMandate.count({ where: { userId } })).toBe(1);
  });

  it("preserves data on a provider sync failure and enforces connection ownership", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    const other = await newUser();
    fake.seedAccounts([{ providerAccountId: "a1", currency: "GBP", institutionName: "Monzo", cachedBalanceMinor: 90000 }]);
    fake.seedSyncPages([{ added: [ptx({ providerTransactionId: "keep", providerAccountId: "a1", amountMinor: 6500, direction: "EXPENSE", bookedAt: "2026-06-20T08:00:00Z", merchantName: "Shell" })] }]);
    const { connectionId } = await connectPlaid(token, "pub-fail");
    const acc = await accountByProvider(userId, "a1");
    expect(await prisma.transaction.count({ where: { userId, accountId: acc.id } })).toBe(1);

    fake.failMode = "sync";
    expect((await post(token, `/bank-connections/${connectionId}/sync`)).status).toBe(502);
    expect(await prisma.transaction.count({ where: { userId, accountId: acc.id } })).toBe(1); // preserved

    // Ownership: another user cannot see/sync/complete/delete this connection.
    expect((await get(other.token, `/bank-connections/${connectionId}`)).status).toBe(404);
    fake.failMode = null;
    expect((await post(other.token, `/bank-connections/${connectionId}/sync`)).status).toBe(404);
    expect((await post(other.token, `/bank-connections/${connectionId}/complete`, { publicToken: "x" })).status).toBe(404);
    expect((await del(other.token, `/bank-connections/${connectionId}`)).status).toBe(404);
  });
});
