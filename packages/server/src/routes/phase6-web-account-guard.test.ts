import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Phase 6 — regression coverage for the web (cookie-session) account balance-edit
// guard added to accounts.routes.ts: a PROVIDER-authoritative account's balance
// must never be editable by hand, only a LEDGER account's may be. This guard had
// no dedicated test until now. Deliberately its own small file (not folded into
// phase6-security.test.ts) so its two /auth/register calls don't compete for that
// file's already-budgeted authLimiter allowance (20 req/15min/IP, shared across
// every /auth/* route — web and mobile alike, same limiter instance).
//
// Opt-in: set MOBILE_TEST_DATABASE_URL to a reachable Postgres, else skips.

let ready = false;
let server: Server | undefined;
let base = "";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;

interface WebFixture { userId: string; cookie: string; csrfToken: string }
let owner: WebFixture;
let attacker: WebFixture;

async function api(method: string, path: string, opts: { fixture?: WebFixture; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.fixture) {
    headers.cookie = opts.fixture.cookie;
    headers["x-csrf-token"] = opts.fixture.csrfToken;
  }
  const res = await fetch(base + path, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

let seq = 0;
async function registerWeb(): Promise<WebFixture> {
  const email = `p6webguard+${Date.now()}_${seq++}@example.com`;
  const res = await fetch(base + "/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password1234" }),
  });
  if (res.status !== 201) throw new Error(`web register failed: ${res.status} ${await res.text()}`);
  const setCookies = res.headers.getSetCookie?.() ?? [];
  const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
  const body = (await res.json()) as { user: { id: string }; csrfToken: string };
  return { userId: body.user.id, cookie, csrfToken: body.csrfToken };
}

beforeAll(async () => {
  const dbUrl = process.env.MOBILE_TEST_DATABASE_URL;
  if (!dbUrl) { ready = false; return; }
  process.env.DATABASE_URL = dbUrl;
  process.env.SESSION_SECRET ||= "test-session-secret-0123456789abcdef";
  process.env.MOBILE_JWT_SECRET ||= "test-mobile-secret-0123456789abcdef";
  process.env.COOKIE_SECURE ||= "false";
  try {
    const db = await import("../db.js");
    prisma = db.prisma;
    await prisma.$queryRaw`SELECT 1`;
    const { createApp } = await import("../app.js");
    server = createApp().listen(0);
    await new Promise((r) => server!.once("listening", r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
    ready = true;
    owner = await registerWeb();
    attacker = await registerWeb();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[phase6-web-account-guard.test] setup failed, skipping:", e);
    ready = false;
  }
});

afterAll(async () => {
  if (server) server.close();
  if (ready && prisma) await prisma.user.deleteMany({ where: { email: { contains: "p6webguard+" } } });
});

describe("Phase 6 — web account-balance edit guard (PROVIDER vs LEDGER, ownership)", () => {
  it("LEDGER account + owner: manual balance edit is allowed", async (ctx) => {
    if (!ready) return ctx.skip();
    const acc = await prisma.bankAccount.create({
      data: { userId: owner.userId, bankName: "Bank", nickname: "Ledger Acct", accountType: "CURRENT", balanceMinor: 1000n, currency: "GBP", balanceAuthority: "LEDGER" },
    });
    const res = await api("PUT", `/accounts/${acc.id}`, { fixture: owner, body: { balanceMinor: 5000 } });
    expect(res.status).toBe(200);
    const after = await prisma.bankAccount.findUnique({ where: { id: acc.id } });
    expect(after.balanceMinor).toBe(5000n);
  });

  it("PROVIDER account + owner: manual balance override is rejected with a clear error", async (ctx) => {
    if (!ready) return ctx.skip();
    const acc = await prisma.bankAccount.create({
      data: { userId: owner.userId, bankName: "Bank", nickname: "Provider Acct", accountType: "CURRENT", balanceMinor: 2000n, currency: "GBP", balanceAuthority: "PROVIDER" },
    });
    const res = await api("PUT", `/accounts/${acc.id}`, { fixture: owner, body: { balanceMinor: 9999 } });
    expect(res.status).toBe(409);
    const after = await prisma.bankAccount.findUnique({ where: { id: acc.id } });
    expect(after.balanceMinor).toBe(2000n); // untouched
  });

  it("PROVIDER account + owner: editing a different field (nickname) without touching balanceMinor is still allowed", async (ctx) => {
    if (!ready) return ctx.skip();
    const acc = await prisma.bankAccount.create({
      data: { userId: owner.userId, bankName: "Bank", nickname: "Provider Acct 2", accountType: "CURRENT", balanceMinor: 3000n, currency: "GBP", balanceAuthority: "PROVIDER" },
    });
    const res = await api("PUT", `/accounts/${acc.id}`, { fixture: owner, body: { nickname: "Renamed" } });
    expect(res.status).toBe(200);
    const after = await prisma.bankAccount.findUnique({ where: { id: acc.id } });
    expect(after.nickname).toBe("Renamed");
    expect(after.balanceMinor).toBe(3000n); // unaffected — no balanceMinor was sent
  });

  it("a different user cannot edit (or discover the existence of) another user's account at all", async (ctx) => {
    if (!ready) return ctx.skip();
    const acc = await prisma.bankAccount.create({
      data: { userId: owner.userId, bankName: "Bank", nickname: "Private Acct", accountType: "CURRENT", balanceMinor: 4000n, currency: "GBP", balanceAuthority: "LEDGER" },
    });
    const res = await api("PUT", `/accounts/${acc.id}`, { fixture: attacker, body: { balanceMinor: 1 } });
    expect(res.status).toBe(404); // ownership check runs before the balance-authority check
    const after = await prisma.bankAccount.findUnique({ where: { id: acc.id } });
    expect(after.balanceMinor).toBe(4000n); // untouched
  });
});
