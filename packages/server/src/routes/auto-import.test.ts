import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Atomic auto-import tests. Opt-in via MOBILE_TEST_DATABASE_URL, run with
// `--pool=forks`. Skip cleanly without a database.

let ready = false;
let server: Server | undefined;
let base = "";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;

const device = { deviceId: "autotest-device-000001", platform: "android" as const };

beforeAll(async () => {
  const dbUrl = process.env.MOBILE_TEST_DATABASE_URL;
  if (!dbUrl) {
    ready = false;
    return;
  }
  process.env.DATABASE_URL = dbUrl;
  process.env.MOBILE_JWT_SECRET ||= "test-mobile-secret-0123456789abcdef";
  process.env.SESSION_SECRET ||= "test-session-secret-0123456789abcdef";
  process.env.COOKIE_SECURE ||= "false";
  try {
    prisma = (await import("../db.js")).prisma;
    await prisma.$queryRaw`SELECT 1`;
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
  if (ready && prisma) await prisma.user.deleteMany({ where: { email: { contains: "autotest+" } } });
});

async function newUserWithAccount(openingMinor: bigint) {
  const email = `autotest+${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await fetch(base + "/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password1234", device }),
  });
  const token = (await reg.json()).accessToken as string;
  const user = await prisma.user.findUnique({ where: { email } });
  const account = await prisma.bankAccount.create({ data: { userId: user.id, bankName: "Monzo", nickname: "Monzo", balanceMinor: openingMinor } });
  return { userId: user.id as string, accountId: account.id as string, token };
}

function auto(token: string, body: Record<string, unknown>) {
  const fp = `fp-${Date.now()}-${Math.random()}`;
  return fetch(`${base}/notification-imports/auto`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      fingerprint: fp, sourcePackage: "co.uk.getmondo", currency: "GBP", occurredAt: new Date().toISOString(),
      confidence: 0.95, redactedSourceText: "redacted", title: "Monzo", ...body,
    }),
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any>, fp }));
}

async function balance(accountId: string): Promise<bigint> {
  return (await prisma.bankAccount.findUnique({ where: { id: accountId } })).balanceMinor as bigint;
}

function bootstrap(token: string) {
  return fetch(`${base}/bootstrap`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
}

describe("atomic auto-import", () => {
  it("Monzo £2 credit updates balance and monthly income", async (ctx) => {
    if (!ready) return ctx.skip();
    const { accountId, token } = await newUserWithAccount(2000n);
    const res = await auto(token, { direction: "INCOME", amountMinor: 200, merchant: "Sardar Saeed", accountId });
    expect(res.status).toBe(201);
    expect(res.json.result).toBe("AUTO_IMPORTED");
    expect(res.json.transaction.id).toBeTruthy();
    expect(res.json.import.status).toBe("APPROVED");
    expect(res.json.import.approvedTransactionId).toBe(res.json.transaction.id);
    expect(await balance(accountId)).toBe(2200n);
    const boot = await bootstrap(token);
    expect(boot.dashboard.incomeMinor).toBeGreaterThanOrEqual(200);
  });

  it("Revolut £50 debit updates balance and monthly spending", async (ctx) => {
    if (!ready) return ctx.skip();
    const { accountId, token } = await newUserWithAccount(6000n);
    const res = await auto(token, { direction: "EXPENSE", amountMinor: 5000, merchant: "Sardar Saeed", sourcePackage: "com.revolut.revolut", accountId });
    expect(res.status).toBe(201);
    expect(await balance(accountId)).toBe(1000n);
    const boot = await bootstrap(token);
    expect(boot.dashboard.expenseMinor).toBeGreaterThanOrEqual(5000);
  });

  it("duplicate callbacks create exactly one transaction and apply the balance once", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accountId, token } = await newUserWithAccount(2000n);
    const fp = `fp-dup-${Date.now()}`;
    const body = {
      fingerprint: fp, sourcePackage: "co.uk.getmondo", direction: "INCOME", amountMinor: 500, currency: "GBP",
      occurredAt: new Date().toISOString(), confidence: 0.95, redactedSourceText: "r", title: "Monzo", accountId,
    };
    const first = await fetch(`${base}/notification-imports/auto`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const second = await fetch(`${base}/notification-imports/auto`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((await second.json()).duplicate).toBe(true);
    expect(await balance(accountId)).toBe(2500n); // applied once
    const count = await prisma.transaction.count({ where: { userId, source: "NOTIFICATION" } });
    expect(count).toBe(1);
  });

  it("rejects an account that does not belong to the user", async (ctx) => {
    if (!ready) return ctx.skip();
    const { token } = await newUserWithAccount(2000n);
    const res = await auto(token, { direction: "INCOME", amountMinor: 100, accountId: "cl000000000000000000000000" });
    expect(res.status).toBe(404);
  });
});
