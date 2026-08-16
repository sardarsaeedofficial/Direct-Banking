import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Phase 6 — auth/session security audit + API ownership/input security tests,
// exercised over real HTTP against the mobile API (see docs/PHASE6_AUDIT.md).
// Opt-in: set MOBILE_TEST_DATABASE_URL to a reachable Postgres, else skips.
//
// authLimiter caps /auth/* at 20 requests per 15 minutes per IP (by design, to
// blunt credential stuffing) — every test in this file shares a small, fixed
// set of users registered once in beforeAll rather than registering fresh users
// per test, so the whole suite stays well under that budget.

let ready = false;
let server: Server | undefined;
let base = "";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let jwt: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sessionSvc: any;
let jwtSecret = "";
const EMAIL_TAG = "p6sec+";

interface Fixture { userId: string; accessToken: string; refreshToken: string }
let owner: Fixture;
let attacker: Fixture;

async function api(method: string, path: string, opts: { token?: string; body?: unknown; rawAuthHeader?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.rawAuthHeader !== undefined) headers.authorization = opts.rawAuthHeader;
  else if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(base + path, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

let seq = 0;
const device = () => ({ deviceId: `sec-device-${Date.now()}-${seq++}`, platform: "android" as const });

async function register(): Promise<Fixture> {
  const email = `${EMAIL_TAG}${Date.now()}_${seq++}@example.com`;
  const res = await api("POST", "/auth/register", { body: { email, password: "password1234", device: device() } });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.json)}`);
  const user = res.json.user as { id: string } | undefined;
  return { userId: user!.id, accessToken: res.json.accessToken as string, refreshToken: res.json.refreshToken as string };
}

beforeAll(async () => {
  const dbUrl = process.env.MOBILE_TEST_DATABASE_URL;
  if (!dbUrl) { ready = false; return; }
  process.env.DATABASE_URL = dbUrl;
  jwtSecret = process.env.MOBILE_JWT_SECRET ||= "test-mobile-secret-0123456789abcdef";
  process.env.SESSION_SECRET ||= "test-session-secret-0123456789abcdef";
  process.env.COOKIE_SECURE ||= "false";
  try {
    const db = await import("../db.js");
    prisma = db.prisma;
    await prisma.$queryRaw`SELECT 1`;
    jwt = await import("../auth/jwt.js");
    sessionSvc = await import("../auth/mobile-session.js");
    const { createApp } = await import("../app.js");
    server = createApp().listen(0);
    await new Promise((r) => server!.once("listening", r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api/mobile/v1`;
    ready = true;
    // Two fixture users, shared across every test below — keeps total /auth/*
    // calls in this file comfortably under the 20-per-15-min limiter.
    owner = await register();
    attacker = await register();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[phase6-security.test] setup failed, skipping:", e);
    ready = false;
  }
});

afterAll(async () => {
  if (server) server.close();
  if (ready && prisma) await prisma.user.deleteMany({ where: { email: { contains: EMAIL_TAG } } });
});

describe("Phase 6 — auth/session security", () => {
  it("rejects a missing bearer token", async (ctx) => {
    if (!ready) return ctx.skip();
    const res = await api("GET", "/me");
    expect(res.status).toBe(401);
  });

  it("rejects a malformed authorization header", async (ctx) => {
    if (!ready) return ctx.skip();
    const res = await api("GET", "/me", { rawAuthHeader: "Basic dXNlcjpwYXNz" });
    expect(res.status).toBe(401);
  });

  it("rejects an expired access token", async (ctx) => {
    if (!ready) return ctx.skip();
    const expired = jwt.signAccessToken({ sub: owner.userId, did: "any" }, jwtSecret, -60); // expired 60s ago
    const res = await api("GET", "/me", { token: expired });
    expect(res.status).toBe(401);
  });

  it("rejects an access token with an invalid signature", async (ctx) => {
    if (!ready) return ctx.skip();
    const forged = jwt.signAccessToken({ sub: owner.userId, did: "any" }, "a-completely-different-secret-0000", 900);
    const res = await api("GET", "/me", { token: forged });
    expect(res.status).toBe(401);
  });

  it("rejects a valid-looking token for a revoked device", async (ctx) => {
    if (!ready) return ctx.skip();
    // A dedicated user so revoking its device can't affect the shared fixtures.
    const throwaway = await register();
    await api("POST", "/auth/logout", { token: throwaway.accessToken, body: { allDevices: false } });
    const res = await api("GET", "/me", { token: throwaway.accessToken });
    expect(res.status).toBe(401);
  });

  it("reusing an already-rotated refresh token revokes the whole device", async (ctx) => {
    if (!ready) return ctx.skip();
    // Exercised directly through the session service (not the rate-limited HTTP
    // route) so this doesn't consume any of the shared /auth/* budget.
    const throwaway = await register();
    const first = await sessionSvc.rotateRefreshToken(throwaway.refreshToken);
    expect(first.ok).toBe(true);
    // Present the OLD (now-consumed) refresh token again — this is reuse/theft.
    const reuse = await sessionSvc.rotateRefreshToken(throwaway.refreshToken);
    expect(reuse.ok).toBe(false);
    expect(reuse.reason).toBe("reuse");
    // The whole device is now revoked — even the token minted by the first
    // legitimate rotation no longer works (it too is now flagged revoked, so
    // presenting it reports "reuse" again — the maximally defensive outcome).
    const afterReuse = await sessionSvc.rotateRefreshToken(first.tokens.refreshToken);
    expect(afterReuse.ok).toBe(false);
    expect(["reuse", "revoked"]).toContain(afterReuse.reason);
  });
});

describe("Phase 6 — cross-user ownership isolation", () => {
  it("no endpoint returns another user's accounts, transactions, budgets, statements, Direct Debits, or review items", async (ctx) => {
    if (!ready) return ctx.skip();
    const acc = await prisma.bankAccount.create({ data: { userId: owner.userId, bankName: "Bank", nickname: "Acct", accountType: "CURRENT", balanceMinor: 0n, currency: "GBP" } });
    const txn = await prisma.transaction.create({ data: { userId: owner.userId, accountId: acc.id, direction: "EXPENSE", amountMinor: 500n, currency: "GBP", bookedAt: new Date(), description: "Private spend" } });
    const groceries = await prisma.category.findFirst({ where: { userId: owner.userId, code: "GROCERIES" } });
    const budget = await prisma.budget.create({ data: { userId: owner.userId, name: "Food", categoryId: groceries.id, limitMinor: 10000n, currency: "GBP", startDate: new Date() } });
    const stmt = await prisma.statementImport.create({ data: { userId: owner.userId, accountId: acc.id, filename: "s.csv", fileType: "CSV", fileHash: `hash-${Date.now()}`, status: "PARSED" } });
    const mandate = await prisma.directDebitMandate.create({ data: { userId: owner.userId, accountId: acc.id, companyName: "Co", normalizedCompanyName: `co${Date.now()}`, firstSeenAt: new Date() } });

    // Every one of these must be invisible to the attacker (403/404, not owner's data).
    const asAttacker = (path: string) => api("GET", path, { token: attacker.accessToken });
    for (const path of [`/statements/${stmt.id}`, `/direct-debits/${mandate.id}`]) {
      const res = await asAttacker(path);
      expect([403, 404]).toContain(res.status);
    }

    // List endpoints must never leak the other user's rows even without a 404.
    const activity = await api("GET", "/activity", { token: attacker.accessToken });
    expect((activity.json.items as unknown[]).some((t: any) => t.id === txn.id)).toBe(false);
    const budgets = await api("GET", "/budgets", { token: attacker.accessToken });
    expect((budgets.json.items as unknown[]).some((b: any) => b.id === budget.id)).toBe(false);
    const statements = await api("GET", "/statements", { token: attacker.accessToken });
    expect((statements.json.items as unknown[]).some((s: any) => s.id === stmt.id)).toBe(false);

    // The attacker cannot merge/pair/act on the owner's transaction either.
    const merge = await api("POST", `/review/${txn.id}/merge`, { token: attacker.accessToken });
    expect(merge.status).toBeGreaterThanOrEqual(400);
    const pair = await api("POST", "/internal-transfers/pair", { token: attacker.accessToken, body: { transactionAId: txn.id, transactionBId: txn.id } });
    expect(pair.status).toBeGreaterThanOrEqual(400);
  });
});

describe("Phase 6 — API input security", () => {
  it("rejects an oversized statement upload", async (ctx) => {
    if (!ready) return ctx.skip();
    const acc = await prisma.bankAccount.create({ data: { userId: owner.userId, bankName: "Bank", nickname: "Acct", accountType: "CURRENT", balanceMinor: 0n, currency: "GBP" } });
    // ~7MB of base64 content — exceeds the configured statement upload limit.
    const huge = Buffer.alloc(7_000_000, "a").toString("base64");
    const res = await api("POST", "/statements", { token: owner.accessToken, body: { accountId: acc.id, filename: "big.csv", fileType: "CSV", contentBase64: huge } });
    expect([400, 413]).toContain(res.status);
  });

  it("rejects a malformed/unparseable CSV statement with a clear error, not a raw crash", async (ctx) => {
    if (!ready) return ctx.skip();
    const acc = await prisma.bankAccount.create({ data: { userId: owner.userId, bankName: "Bank", nickname: "Acct", accountType: "CURRENT", balanceMinor: 0n, currency: "GBP" } });
    const junk = Buffer.from("this is not a statement at all, just prose.\nno dates, no amounts.").toString("base64");
    const res = await api("POST", "/statements", { token: owner.accessToken, body: { accountId: acc.id, filename: "junk.csv", fileType: "CSV", contentBase64: junk } });
    expect(res.status).toBe(201); // recorded as a FAILED import, not a 500
    expect((res.json.import as { status: string }).status).toBe("FAILED");
    expect(JSON.stringify(res.json)).not.toMatch(/at\s+\w+\s+\(.*:\d+:\d+\)/); // no stack trace leaked
  });

  it("never accepts an accountId belonging to another user (mass-assignment / ownership on write)", async (ctx) => {
    if (!ready) return ctx.skip();
    const ownerAcc = await prisma.bankAccount.create({ data: { userId: owner.userId, bankName: "Bank", nickname: "Acct", accountType: "CURRENT", balanceMinor: 0n, currency: "GBP" } });
    const csv = Buffer.from("Date,Description,Amount\n01/01/2026,Test,-10.00").toString("base64");
    const res = await api("POST", "/statements", { token: attacker.accessToken, body: { accountId: ownerAcc.id, filename: "x.csv", fileType: "CSV", contentBase64: csv } });
    expect(res.status).toBe(404); // attacker cannot target another user's account
  });

  it("returns a clean 400 for an invalid transaction id rather than a raw DB error", async (ctx) => {
    if (!ready) return ctx.skip();
    const res = await api("POST", "/internal-transfers/pair", { token: owner.accessToken, body: { transactionAId: "not-a-real-id", transactionBId: "also-not-real" } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(JSON.stringify(res.json)).not.toMatch(/at\s+\w+\s+\(.*:\d+:\d+\)/);
  });
});

describe("Phase 6 — category deletion detaches references (no orphaned FK, no raw 500)", () => {
  it("deleting a category in use nulls out transactions/budgets/merchants and reparents children", async (ctx) => {
    if (!ready) return ctx.skip();
    const acc = await prisma.bankAccount.create({ data: { userId: owner.userId, bankName: "Bank", nickname: "Acct", accountType: "CURRENT", balanceMinor: 0n, currency: "GBP" } });
    const custom = await prisma.category.create({ data: { userId: owner.userId, name: `Custom Cat ${Date.now()}`, colour: "#111111" } });
    const child = await prisma.category.create({ data: { userId: owner.userId, name: `Custom Child ${Date.now()}`, colour: "#222222", parentId: custom.id } });
    const txn = await prisma.transaction.create({ data: { userId: owner.userId, accountId: acc.id, direction: "EXPENSE", amountMinor: 100n, currency: "GBP", bookedAt: new Date(), description: "x", categoryId: custom.id } });
    const budget = await prisma.budget.create({ data: { userId: owner.userId, name: `B${Date.now()}`, categoryId: custom.id, limitMinor: 1000n, currency: "GBP", startDate: new Date() } });
    const merchant = await prisma.merchant.create({ data: { userId: owner.userId, displayName: "M", normalisedKey: `m${Date.now()}`, defaultCategoryId: custom.id } });

    const res = await api("DELETE", `/categories/${custom.id}`, { token: owner.accessToken });
    expect(res.status).toBe(200);

    expect((await prisma.transaction.findUnique({ where: { id: txn.id } })).categoryId).toBeNull();
    expect((await prisma.budget.findUnique({ where: { id: budget.id } })).categoryId).toBeNull();
    expect((await prisma.merchant.findUnique({ where: { id: merchant.id } })).defaultCategoryId).toBeNull();
    expect((await prisma.category.findUnique({ where: { id: child.id } })).parentId).toBeNull();
    expect(await prisma.category.findUnique({ where: { id: custom.id } })).toBeNull();
  });

  it("a default (system) category cannot be deleted", async (ctx) => {
    if (!ready) return ctx.skip();
    const groceries = await prisma.category.findFirst({ where: { userId: owner.userId, code: "GROCERIES" } });
    const res = await api("DELETE", `/categories/${groceries.id}`, { token: owner.accessToken });
    expect(res.status).toBe(400);
    expect(await prisma.category.findUnique({ where: { id: groceries.id } })).toBeTruthy();
  });
});
