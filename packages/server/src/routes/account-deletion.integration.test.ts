import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Final release completion (§3): DELETE /api/mobile/v1/me. Opt-in via
// MOBILE_TEST_DATABASE_URL, same pattern as mobile-register.test.ts.

let ready = false;
let server: Server | undefined;
let base = "";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;

const device = { deviceId: "del-test-device-000001", platform: "android" as const };
const PASSWORD = "password1234";

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
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[account-deletion.test] setup failed, skipping:", e);
    ready = false;
  }
});

afterAll(async () => {
  if (server) server.close();
  if (ready && prisma) await prisma.user.deleteMany({ where: { email: { contains: "deltest+" } } });
});

function auth(t: string) { return { authorization: `Bearer ${t}` }; }
function get(t: string, path: string) {
  return fetch(`${base}${path}`, { headers: auth(t) }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> }));
}
function del(t: string, path: string, body?: unknown) {
  return fetch(`${base}${path}`, { method: "DELETE", headers: { "content-type": "application/json", ...auth(t) }, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> }));
}

async function newUser(tag: string) {
  // registerUser() lowercases the email before storing it — look up the same
  // lowercased form, or a mixed-case tag (e.g. "crossB") would never match.
  const email = `deltest+${tag}${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`.toLowerCase();
  const reg = await fetch(base + "/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD, device: { ...device, deviceId: `${device.deviceId}-${tag}` } }) });
  const body = await reg.json();
  const user = await prisma.user.findUnique({ where: { email } });
  return { userId: user.id as string, token: body.accessToken as string, refreshToken: body.refreshToken as string, email };
}

describe("DELETE /me — account deletion", () => {
  it("rejects an unauthenticated request", async (ctx) => {
    if (!ready) return ctx.skip();
    const res = await fetch(base + "/me", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD, confirm: "DELETE" }) });
    expect(res.status).toBe(401);
  });

  it("rejects the wrong password without deleting the account", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser("wrongpw");
    const res = await del(u.token, "/me", { password: "not-the-password", confirm: "DELETE" });
    expect(res.status).toBe(401);
    expect(await prisma.user.findUnique({ where: { id: u.userId } })).toBeTruthy();
  });

  it("rejects a missing or wrong confirmation phrase without deleting the account", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser("badconfirm");
    const res1 = await del(u.token, "/me", { password: PASSWORD, confirm: "delete" }); // wrong case
    expect(res1.status).toBe(400);
    const res2 = await del(u.token, "/me", { password: PASSWORD }); // missing confirm entirely
    expect(res2.status).toBe(400);
    expect(await prisma.user.findUnique({ where: { id: u.userId } })).toBeTruthy();
  });

  it("deletes the user's own account with the correct password + confirmation", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser("own");
    const res = await del(u.token, "/me", { password: PASSWORD, confirm: "DELETE" });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(await prisma.user.findUnique({ where: { id: u.userId } })).toBeNull();
  });

  it("invalidates the session — a subsequent /me request with the same access token fails", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser("sess");
    await del(u.token, "/me", { password: PASSWORD, confirm: "DELETE" });
    const after = await get(u.token, "/me");
    expect(after.status).toBe(401);
  });

  it("revokes every mobile device/refresh token row (cascade) — none survive the deleted user", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser("tokens");
    const deviceRow = await prisma.mobileDevice.findFirst({ where: { userId: u.userId } });
    expect(deviceRow).toBeTruthy();
    await del(u.token, "/me", { password: PASSWORD, confirm: "DELETE" });
    expect(await prisma.mobileDevice.findUnique({ where: { id: deviceRow.id } })).toBeNull();
    expect(await prisma.mobileRefreshToken.findMany({ where: { userId: u.userId } })).toHaveLength(0);
  });

  it("user A deleting their own account never touches user B's data", async (ctx) => {
    if (!ready) return ctx.skip();
    const a = await newUser("crossA");
    const b = await newUser("crossB");
    const bAccount = await prisma.bankAccount.create({ data: { userId: b.userId, bankName: "B's Bank", nickname: "B current", currency: "GBP", balanceMinor: 1000n } });
    await del(a.token, "/me", { password: PASSWORD, confirm: "DELETE" });
    expect(await prisma.user.findUnique({ where: { id: a.userId } })).toBeNull();
    expect(await prisma.user.findUnique({ where: { id: b.userId } })).toBeTruthy();
    expect(await prisma.bankAccount.findUnique({ where: { id: bAccount.id } })).toBeTruthy();
    const bStillWorks = await get(b.token, "/me");
    expect(bStillWorks.status).toBe(200);
  });

  it("handles every dependent record type safely: cascades user data, anonymises (never deletes) audit log rows", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser("deep");

    const account = await prisma.bankAccount.create({ data: { userId: u.userId, bankName: "Test Bank", nickname: "Current", currency: "GBP", balanceMinor: 5000n } });
    const category = await prisma.category.findFirst({ where: { userId: u.userId } });
    const txn = await prisma.transaction.create({
      data: { userId: u.userId, accountId: account.id, direction: "EXPENSE", amountMinor: 488n, currency: "GBP", bookedAt: new Date(), description: "Test purchase", categoryId: category?.id },
    });
    const notif = await prisma.notificationImport.create({
      data: { userId: u.userId, sourcePackage: "com.example.bank", title: "Test", message: "Test £4.88", receivedAt: new Date(), sourceHash: `del-test-${u.userId}` },
    });
    const finEvent = await prisma.financialEvent.create({
      data: {
        userId: u.userId, sourceType: "MANUAL", sourceFingerprint: `del-test-fp-${u.userId}`,
        eventKind: "CARD_PURCHASE", lifecycle: "COMPLETED", amountMinor: 488, currency: "GBP",
        moneyEffect: "DEBIT", ledgerImpact: "POSTED", confidenceScore: 1, confidenceLevel: "HIGH",
      },
    });
    const auditLog = await prisma.auditLog.create({ data: { userId: u.userId, action: "test.action", entityType: "Test", entityId: "1" } });

    const res = await del(u.token, "/me", { password: PASSWORD, confirm: "DELETE" });
    expect(res.status).toBe(200);

    // Every user-owned row is gone.
    expect(await prisma.user.findUnique({ where: { id: u.userId } })).toBeNull();
    expect(await prisma.bankAccount.findUnique({ where: { id: account.id } })).toBeNull();
    expect(await prisma.transaction.findUnique({ where: { id: txn.id } })).toBeNull();
    expect(await prisma.notificationImport.findUnique({ where: { id: notif.id } })).toBeNull();
    expect(await prisma.financialEvent.findUnique({ where: { id: finEvent.id } })).toBeNull();
    expect(await prisma.category.findMany({ where: { userId: u.userId } })).toHaveLength(0);

    // AuditLog is the one documented exception: it survives, anonymised.
    const survivingAudit = await prisma.auditLog.findUnique({ where: { id: auditLog.id } });
    expect(survivingAudit).toBeTruthy();
    expect(survivingAudit.userId).toBeNull();
  });
});
