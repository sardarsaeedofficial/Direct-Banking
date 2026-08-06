import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Balance-consistency tests (Defect 1). Opt-in via MOBILE_TEST_DATABASE_URL and
// run with `--pool=forks` (Prisma's query engine hangs under the worker pool).
// They skip cleanly without a database so the default unit gate stays green.

let ready = false;
let server: Server | undefined;
let base = "";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createTransaction: any;

const device = { deviceId: "baltest-device-000001", platform: "android" as const };

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
    createTransaction = (await import("../services/transactions.service.js")).createTransaction;
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
  if (ready && prisma) await prisma.user.deleteMany({ where: { email: { contains: "baltest+" } } });
});

async function newUserWithAccount(openingMinor: bigint) {
  const email = `baltest+${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await fetch(base + "/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password1234", device }),
  });
  const token = (await reg.json()).accessToken as string;
  const user = await prisma.user.findUnique({ where: { email } });
  const account = await prisma.bankAccount.create({
    data: { userId: user.id, bankName: "Test", nickname: "Everyday", balanceMinor: openingMinor },
  });
  return { userId: user.id as string, accountId: account.id as string, token };
}

async function balance(accountId: string): Promise<bigint> {
  return (await prisma.bankAccount.findUnique({ where: { id: accountId } })).balanceMinor as bigint;
}

async function createImport(userId: string, amountMinor: number, direction: "INCOME" | "EXPENSE") {
  return prisma.notificationImport.create({
    data: {
      userId, sourcePackage: "com.example.bank", title: "Bank", message: "redacted", receivedAt: new Date(),
      parsedAmountMinor: BigInt(amountMinor), direction, currency: "GBP", confidence: 0.95,
      sourceHash: `fp-${Date.now()}-${Math.random()}`, status: "PENDING", reviewState: "DRAFT",
    },
  });
}

function patch(id: string, token: string, body: unknown) {
  return fetch(`${base}/notification-imports/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe("account balance stays consistent", () => {
  it("opening £20 + £50 credit = £70", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accountId } = await newUserWithAccount(2000n);
    await createTransaction(userId, { accountId, direction: "INCOME", status: "COMPLETED", amountMinor: 5000, bookedAt: new Date(), description: "Credit" });
    expect(await balance(accountId)).toBe(7000n);
  });

  it("opening £20 − £10 debit = £10", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accountId } = await newUserWithAccount(2000n);
    await createTransaction(userId, { accountId, direction: "EXPENSE", status: "COMPLETED", amountMinor: 1000, bookedAt: new Date(), description: "Debit" });
    expect(await balance(accountId)).toBe(1000n);
  });

  it("repeated approval does not double-count", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accountId, token } = await newUserWithAccount(2000n);
    const imp = await createImport(userId, 5000, "INCOME");
    const first = await patch(imp.id, token, { action: "approve", accountId });
    expect(first.status).toBe(201);
    expect(await balance(accountId)).toBe(7000n);
    const second = await patch(imp.id, token, { action: "approve", accountId });
    expect(second.status).toBe(200); // idempotent, not a second charge
    expect(await balance(accountId)).toBe(7000n); // unchanged
  });

  it("rejected imports do not affect the balance", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accountId, token } = await newUserWithAccount(2000n);
    const imp = await createImport(userId, 5000, "INCOME");
    const rej = await patch(imp.id, token, { action: "reject" });
    expect(rej.status).toBe(200);
    expect(await balance(accountId)).toBe(2000n);
  });
});
