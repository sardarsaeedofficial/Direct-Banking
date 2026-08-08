import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Ledger + internal-transfer integration tests. Opt-in via MOBILE_TEST_DATABASE_URL,
// run with `--pool=forks`. Skips cleanly without a database.

let ready = false;
let server: Server | undefined;
let base = "";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;

const device = { deviceId: "ledger-test-device-01", platform: "android" as const };

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
  if (ready && prisma) await prisma.user.deleteMany({ where: { email: { contains: "ledger+" } } });
});

async function newUser() {
  const email = `ledger+${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await fetch(base + "/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password1234", device }),
  });
  const token = (await reg.json()).accessToken as string;
  const user = await prisma.user.findUnique({ where: { email } });
  return { userId: user.id as string, token };
}

async function account(userId: string, bankName: string, holder?: string, openingMinor = 0n) {
  const a = await prisma.bankAccount.create({
    data: { userId, bankName, nickname: bankName, balanceMinor: openingMinor, accountHolderName: holder ?? null },
  });
  return a.id as string;
}

function auto(token: string, body: Record<string, unknown>) {
  const fp = `fp-${Date.now()}-${Math.random()}`;
  return fetch(`${base}/notification-imports/auto`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      fingerprint: fp,
      sourcePackage: "co.uk.getmondo",
      currency: "GBP",
      occurredAt: new Date().toISOString(),
      confidence: 0.95,
      redactedSourceText: "redacted",
      title: "Bank",
      ...body,
    }),
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any>, fp }));
}

function bootstrap(token: string) {
  return fetch(`${base}/bootstrap`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
}
function correct(token: string, id: string, body: Record<string, unknown>) {
  return fetch(`${base}/transactions/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));
}
async function balance(accountId: string): Promise<bigint> {
  return (await prisma.bankAccount.findUnique({ where: { id: accountId } })).balanceMinor as bigint;
}
async function typeOf(id: string): Promise<string | null> {
  return (await prisma.transaction.findUnique({ where: { id } })).transactionType;
}

describe("financial ledger — internal transfers", () => {
  it("pairs a £100 Monzo debit and £100 Revolut credit into one INTERNAL_TRANSFER with £0 income/spending", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    const monzo = await account(userId, "Monzo", "Sardar Saeed", 20000n);
    const revolut = await account(userId, "Revolut", "Sardar Saeed", 0n);
    const when = new Date().toISOString();

    const debit = await auto(token, { direction: "EXPENSE", amountMinor: 10000, accountId: monzo, occurredAt: when, recipientName: "Sardar Saeed" });
    const credit = await auto(token, { direction: "INCOME", amountMinor: 10000, sourcePackage: "com.revolut.revolut", accountId: revolut, occurredAt: when, senderName: "Sardar Saeed" });
    expect(debit.status).toBe(201);
    expect(credit.status).toBe(201);

    // Both sides are now classified as INTERNAL_TRANSFER and share a group id.
    expect(await typeOf(debit.json.transaction.id)).toBe("INTERNAL_TRANSFER");
    expect(await typeOf(credit.json.transaction.id)).toBe("INTERNAL_TRANSFER");
    const g1 = (await prisma.transaction.findUnique({ where: { id: debit.json.transaction.id } })).internalTransferGroupId;
    const g2 = (await prisma.transaction.findUnique({ where: { id: credit.json.transaction.id } })).internalTransferGroupId;
    expect(g1).toBeTruthy();
    expect(g1).toBe(g2);

    // Dashboard: neither income nor spending; balances still moved (net worth £0).
    const boot = await bootstrap(token);
    expect(boot.dashboard.incomeMinor).toBe(0);
    expect(boot.dashboard.expenseMinor).toBe(0);
    expect(await balance(monzo)).toBe(10000n);
    expect(await balance(revolut)).toBe(10000n);
  });

  it("keeps a £2,000 salary as INCOME", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    const acc = await account(userId, "Monzo", "Sardar Saeed", 0n);
    const res = await auto(token, { direction: "INCOME", amountMinor: 200000, accountId: acc, merchant: "ACME Payroll", senderName: "ACME Ltd" });
    expect(res.status).toBe(201);
    expect(await typeOf(res.json.transaction.id)).toBe("INCOME");
    const boot = await bootstrap(token);
    expect(boot.dashboard.incomeMinor).toBeGreaterThanOrEqual(200000);
  });

  it("does NOT make a £50 payment to an unrelated same-name person internal (name alone is insufficient)", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    const monzo = await account(userId, "Monzo", "Sardar Saeed", 10000n);
    await account(userId, "Revolut", "Sardar Saeed", 0n); // own account with same holder name exists
    // Only the outgoing side exists; there is no matching incoming £50 on an owned account.
    const res = await auto(token, { direction: "EXPENSE", amountMinor: 5000, accountId: monzo, recipientName: "Sardar Saeed" });
    expect(res.status).toBe(201);
    expect(await typeOf(res.json.transaction.id)).not.toBe("INTERNAL_TRANSFER"); // stays a PURCHASE
    const row = await prisma.transaction.findUnique({ where: { id: res.json.transaction.id } });
    expect(row.transactionType).toBe("PURCHASE");
    // Surfaced as a POSSIBLE candidate for the user to confirm, but still counts as spending.
    expect(row.internalTransferConfidence).toBe("POSSIBLE");
    const boot = await bootstrap(token);
    expect(boot.dashboard.expenseMinor).toBeGreaterThanOrEqual(5000);
  });

  it("does not pair two same-amount transactions in the same direction", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    const a = await account(userId, "Monzo", "Sardar Saeed", 20000n);
    const b = await account(userId, "Revolut", "Sardar Saeed", 20000n);
    const t1 = await auto(token, { direction: "EXPENSE", amountMinor: 7500, accountId: a });
    const t2 = await auto(token, { direction: "EXPENSE", amountMinor: 7500, sourcePackage: "com.revolut.revolut", accountId: b });
    expect(await typeOf(t1.json.transaction.id)).not.toBe("INTERNAL_TRANSFER");
    expect(await typeOf(t2.json.transaction.id)).not.toBe("INTERNAL_TRANSFER");
  });

  it("recalculates the dashboard when a normal payment is marked, then unmarked, as an internal transfer", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    const acc = await account(userId, "Monzo", "Sardar Saeed", 10000n);
    const res = await auto(token, { direction: "EXPENSE", amountMinor: 3000, accountId: acc, merchant: "Corner Shop" });
    const id = res.json.transaction.id as string;
    expect((await bootstrap(token)).dashboard.expenseMinor).toBeGreaterThanOrEqual(3000);
    const before = await balance(acc);

    // Mark as internal → excluded from spending, balance untouched.
    const marked = await correct(token, id, { markInternalTransfer: true });
    expect(marked.status).toBe(200);
    expect(await typeOf(id)).toBe("INTERNAL_TRANSFER");
    expect((await bootstrap(token)).dashboard.expenseMinor).toBe(0);
    expect(await balance(acc)).toBe(before);

    // Undo → restored to normal spending, balance still untouched.
    const undone = await correct(token, id, { markInternalTransfer: false });
    expect(undone.status).toBe(200);
    expect(await typeOf(id)).toBe("PURCHASE");
    expect((await bootstrap(token)).dashboard.expenseMinor).toBeGreaterThanOrEqual(3000);
    expect(await balance(acc)).toBe(before);
  });

  it("duplicate auto-import callbacks create exactly one transaction", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    const acc = await account(userId, "Monzo", "Sardar Saeed", 5000n);
    const fp = `fp-dup-${Date.now()}`;
    const body = {
      fingerprint: fp, sourcePackage: "co.uk.getmondo", direction: "INCOME", amountMinor: 1000, currency: "GBP",
      occurredAt: new Date().toISOString(), confidence: 0.95, redactedSourceText: "r", title: "Monzo", accountId: acc,
    };
    const post = () => fetch(`${base}/notification-imports/auto`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const first = await post();
    const second = await post();
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const count = await prisma.transaction.count({ where: { userId, source: "NOTIFICATION" } });
    expect(count).toBe(1);
  });

  it("preserves legacy balanceApplied=false protections when reclassifying", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, token } = await newUser();
    const acc = await account(userId, "Monzo", "Sardar Saeed", 12345n);
    // A legacy row whose effect was never applied to the balance.
    const legacy = await prisma.transaction.create({
      data: {
        userId, accountId: acc, direction: "EXPENSE", amountMinor: 999n, currency: "GBP",
        bookedAt: new Date(), description: "Legacy", balanceApplied: false, transactionType: "PURCHASE",
      },
    });
    const before = await balance(acc);
    await correct(token, legacy.id, { markInternalTransfer: true });
    await correct(token, legacy.id, { markInternalTransfer: false });
    const row = await prisma.transaction.findUnique({ where: { id: legacy.id } });
    expect(row.balanceApplied).toBe(false); // never flipped on
    expect(await balance(acc)).toBe(before); // balance never moved
  });
});
