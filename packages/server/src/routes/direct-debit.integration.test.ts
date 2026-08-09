import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Direct Debit engine integration tests. Opt-in via MOBILE_TEST_DATABASE_URL,
// run with `--pool=forks`. Skips cleanly without a database.

let ready = false;
let server: Server | undefined;
let base = "";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;

const device = { deviceId: "dd-test-device-01", platform: "android" as const };

beforeAll(async () => {
  const dbUrl = process.env.MOBILE_TEST_DATABASE_URL;
  if (!dbUrl) return;
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
  if (ready && prisma) await prisma.user.deleteMany({ where: { email: { contains: "ddtest+" } } });
});

async function newUser() {
  const email = `ddtest+${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await fetch(base + "/auth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password1234", device }),
  });
  const token = (await reg.json()).accessToken as string;
  const user = await prisma.user.findUnique({ where: { email } });
  return { userId: user.id as string, token };
}
async function account(userId: string, bankName: string, holder = "Sardar Saeed", openingMinor = 500000n) {
  return (await prisma.bankAccount.create({ data: { userId, bankName, nickname: bankName, balanceMinor: openingMinor, accountHolderName: holder } })).id as string;
}

let fpN = 0;
function dd(token: string, company: string, amountMinor: number, accountId: string, whenIso: string, sourcePackage = "co.uk.getmondo", textOverride?: string) {
  return fetch(`${base}/notification-imports/auto`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      fingerprint: `ddfp-${Date.now()}-${fpN++}`, sourcePackage, direction: "EXPENSE",
      amountMinor, currency: "GBP", occurredAt: whenIso, confidence: 0.95,
      redactedSourceText: textOverride ?? `${company} Direct Debit`, title: company, merchant: company, accountId,
    }),
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));
}
function get(token: string, path: string) {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));
}
function patch(token: string, path: string, body: Record<string, unknown>) {
  return fetch(`${base}${path}`, { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));
}
const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d, 9, 0, 0)).toISOString();
async function txn(id: string) { return prisma.transaction.findUnique({ where: { id } }); }
async function mandateCount(userId: string) { return prisma.directDebitMandate.count({ where: { userId } }); }

describe("Direct Debit engine", () => {
  it("first British Gas DD creates a company; the second appends to its history", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    const acc = await account(userId, "Monzo");
    const first = await dd(token, "British Gas", 8200, acc, iso(2026, 5, 15));
    expect(first.status).toBe(201);
    const t1 = await txn(first.json.transaction.id);
    expect(t1.transactionType).toBe("DIRECT_DEBIT");
    expect(t1.directDebitMandateId).toBeTruthy();
    expect(t1.ddAnomaly).toBe("FIRST_PAYMENT");
    expect(await mandateCount(userId)).toBe(1);

    const second = await dd(token, "BRITISH GAS SERVICES", 7900, acc, iso(2026, 6, 15));
    const t2 = await txn(second.json.transaction.id);
    expect(t2.directDebitMandateId).toBe(t1.directDebitMandateId); // same company (normalised)
    expect(await mandateCount(userId)).toBe(1); // NOT a new company each month
    const list = await get(token, "/direct-debits");
    expect(list.json.items[0].paymentCount).toBe(2);
  });

  it("does not merge an unrelated similarly-named company", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    const acc = await account(userId, "Monzo");
    await dd(token, "British Gas", 8000, acc, iso(2026, 5, 15));
    await dd(token, "British Airways", 8000, acc, iso(2026, 5, 16));
    expect(await mandateCount(userId)).toBe(2);
  });

  it("treats an in-tolerance bill as NORMAL and a spike as ABOVE_EXPECTED", async (ctx) => {
    if (!ready) return ctx.skip();
    const { token } = await newUser();
    const uid = (await get(token, "/me")).json.user.id;
    const acc = await account(uid, "Monzo");
    await dd(token, "British Gas", 8000, acc, iso(2026, 2, 15));
    await dd(token, "British Gas", 7900, acc, iso(2026, 3, 15));
    await dd(token, "British Gas", 8100, acc, iso(2026, 4, 15));
    const normal = await dd(token, "British Gas", 8200, acc, iso(2026, 5, 15));
    expect((await txn(normal.json.transaction.id)).ddAnomaly).toBe("NORMAL");
    const spike = await dd(token, "British Gas", 12500, acc, iso(2026, 6, 15));
    expect((await txn(spike.json.transaction.id)).ddAnomaly).toBe("ABOVE_EXPECTED");
  });

  it("honours a user-configured RANGE for anomaly detection", async (ctx) => {
    if (!ready) return ctx.skip();
    const { token } = await newUser();
    const uid = (await get(token, "/me")).json.user.id;
    const acc = await account(uid, "Monzo");
    const first = await dd(token, "British Gas", 8000, acc, iso(2026, 3, 15));
    const mandateId = (await txn(first.json.transaction.id)).directDebitMandateId;
    await patch(token, `/direct-debits/${mandateId}`, {
      expectationMode: "RANGE", userExpectedMinMinor: 7000, userExpectedMaxMinor: 10000, amountTolerancePercent: 0,
    });
    const inRange = await dd(token, "British Gas", 9000, acc, iso(2026, 4, 15));
    expect((await txn(inRange.json.transaction.id)).ddAnomaly).toBe("NORMAL");
    const over = await dd(token, "British Gas", 12000, acc, iso(2026, 5, 15));
    expect((await txn(over.json.transaction.id)).ddAnomaly).toBe("ABOVE_EXPECTED");
  });

  it("predicts the next expected date from history", async (ctx) => {
    if (!ready) return ctx.skip();
    const { token } = await newUser();
    const uid = (await get(token, "/me")).json.user.id;
    const acc = await account(uid, "Monzo");
    await dd(token, "Netflix", 1799, acc, iso(2026, 4, 15));
    await dd(token, "Netflix", 1799, acc, iso(2026, 5, 16));
    const last = await dd(token, "Netflix", 1799, acc, iso(2026, 6, 15));
    const mandateId = (await txn(last.json.transaction.id)).directDebitMandateId;
    const detail = await get(token, `/direct-debits/${mandateId}`);
    const next = new Date(detail.json.mandate.nextExpectedAt);
    expect(next.getUTCMonth()).toBe(7); // August follows the July payment
  });

  it("user override beats the learned prediction", async (ctx) => {
    if (!ready) return ctx.skip();
    const { token } = await newUser();
    const uid = (await get(token, "/me")).json.user.id;
    const acc = await account(uid, "Monzo");
    const first = await dd(token, "Vodafone", 3400, acc, iso(2026, 4, 15));
    const mandateId = (await txn(first.json.transaction.id)).directDebitMandateId;
    await dd(token, "Vodafone", 9900, acc, iso(2026, 5, 15)); // would skew a mean
    await patch(token, `/direct-debits/${mandateId}`, { userExpectedAmountMinor: 3400 });
    const detail = await get(token, `/direct-debits/${mandateId}`);
    expect(detail.json.mandate.effectiveAmountMinor).toBe(3400);
  });

  it("keeps a cancelled mandate and its history", async (ctx) => {
    if (!ready) return ctx.skip();
    const { token } = await newUser();
    const uid = (await get(token, "/me")).json.user.id;
    const acc = await account(uid, "Monzo");
    const first = await dd(token, "Gym", 2500, acc, iso(2026, 4, 15));
    const mandateId = (await txn(first.json.transaction.id)).directDebitMandateId;
    await patch(token, `/direct-debits/${mandateId}`, { status: "CANCELLED" });
    const detail = await get(token, `/direct-debits/${mandateId}`);
    expect(detail.json.mandate.status).toBe("CANCELLED");
    const history = await get(token, `/direct-debits/${mandateId}/history`);
    expect(history.json.items.length).toBe(1);
  });

  it("never creates a Direct Debit from an internal transfer", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    const monzo = await account(userId, "Monzo");
    const revolut = await account(userId, "Revolut");
    const when = iso(2026, 5, 15);
    // No "direct debit" wording; paired opposite legs → internal transfer.
    await dd(token, "Sardar Saeed", 10000, monzo, when, "co.uk.getmondo", "You sent £100 to Sardar Saeed");
    await fetch(`${base}/notification-imports/auto`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ fingerprint: `it-${Date.now()}`, sourcePackage: "com.revolut.revolut", direction: "INCOME", amountMinor: 10000, currency: "GBP", occurredAt: when, confidence: 0.95, redactedSourceText: "£100 from Sardar Saeed", title: "Revolut", merchant: "Sardar Saeed", accountId: revolut, senderName: "Sardar Saeed" }),
    });
    expect(await mandateCount(userId)).toBe(0);
  });

  it("counts Direct Debits in monthly totals and reconciles upcoming totals", async (ctx) => {
    if (!ready) return ctx.skip();
    const { token } = await newUser();
    const uid = (await get(token, "/me")).json.user.id;
    const acc = await account(uid, "Monzo");
    const now = new Date();
    const first = await dd(token, "Netflix", 1799, acc, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), Math.min(now.getUTCDate(), 28), 9)).toISOString());
    const boot = await get(token, "/bootstrap");
    expect(boot.json.dashboard.directDebitsThisMonthMinor).toBeGreaterThanOrEqual(1799);

    // Set an explicit upcoming date tomorrow → appears in the 7-day window.
    const mandateId = (await txn(first.json.transaction.id)).directDebitMandateId;
    const tomorrow = new Date(now.getTime() + 86_400_000).toISOString();
    await patch(token, `/direct-debits/${mandateId}`, { userExpectedDate: tomorrow });
    const up = await get(token, "/upcoming-payments?days=7");
    expect(up.json.items.length).toBeGreaterThanOrEqual(1);
    expect(up.json.totalMinor).toBeGreaterThanOrEqual(1799);
  });

  it("does not create duplicate payments for repeated callbacks and preserves balances", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    const acc = await account(userId, "Monzo", "Sardar Saeed", 100000n);
    const fp = `dd-dup-${Date.now()}`;
    const body = {
      fingerprint: fp, sourcePackage: "co.uk.getmondo", direction: "EXPENSE", amountMinor: 8200, currency: "GBP",
      occurredAt: iso(2026, 5, 15), confidence: 0.95, redactedSourceText: "British Gas Direct Debit", title: "British Gas", merchant: "British Gas", accountId: acc,
    };
    const post = () => fetch(`${base}/notification-imports/auto`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const first = await post();
    const second = await post();
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const count = await prisma.transaction.count({ where: { userId, directDebitMandateId: { not: null } } });
    expect(count).toBe(1);
    expect((await prisma.bankAccount.findUnique({ where: { id: acc } })).balanceMinor).toBe(91800n); // 100000 − 8200, once
  });

  it("preserves legacy balanceApplied=false rows when marking a DD via correction", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    const acc = await account(userId, "Monzo", "Sardar Saeed", 50000n);
    const legacy = await prisma.transaction.create({
      data: { userId, accountId: acc, direction: "EXPENSE", amountMinor: 1200n, currency: "GBP", bookedAt: new Date(), description: "SPOTIFY", merchantName: "Spotify", balanceApplied: false, transactionType: "PURCHASE" },
    });
    const before = (await prisma.bankAccount.findUnique({ where: { id: acc } })).balanceMinor;
    await patch(token, `/transactions/${legacy.id}`, { markDirectDebit: true, directDebitCompany: "Spotify" });
    const row = await txn(legacy.id);
    expect(row.transactionType).toBe("DIRECT_DEBIT");
    expect(row.balanceApplied).toBe(false); // never flipped
    expect((await prisma.bankAccount.findUnique({ where: { id: acc } })).balanceMinor).toBe(before); // balance untouched
  });
});
