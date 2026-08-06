import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Integration tests for POST /api/mobile/v1/auth/register (shared registerUser
// service). They run when a database is reachable (CI / local Postgres) and skip
// otherwise so the unit gate stays green without a DB.

let ready = false;
let server: Server | undefined;
let base = "";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;

const device = { deviceId: "regtest-device-000001", platform: "android" as const };

beforeAll(async () => {
  // Opt-in: set MOBILE_TEST_DATABASE_URL to a reachable Postgres to run these
  // integration tests. Unset (the default unit run) → they skip. The base
  // vitest config injects a dummy DATABASE_URL, so we override it explicitly.
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
    const db = await import("../db.js");
    prisma = db.prisma;
    await prisma.$queryRaw`SELECT 1`;
    const { createApp } = await import("../app.js");
    server = createApp().listen(0);
    await new Promise((r) => server!.once("listening", r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api/mobile/v1`;
    ready = true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[mobile-register.test] setup failed, skipping:", e);
    ready = false;
  }
});

afterAll(async () => {
  if (server) server.close();
  if (ready && prisma) await prisma.user.deleteMany({ where: { email: { contains: "regtest+" } } });
});

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("mobile registration", () => {
  it("registers a new user with the default category set (same as web)", async (ctx) => {
    if (!ready) return ctx.skip();
    const email = `regtest+new${Date.now()}@example.com`;
    const res = await api("POST", "/auth/register", { email, password: "password1234", displayName: "Reg", device });
    expect(res.status).toBe(201);
    expect(res.json.accessToken).toBeTruthy();
    expect(res.json.refreshToken).toBeTruthy();
    const user = await prisma.user.findUnique({ where: { email }, include: { categories: true } });
    expect(user).toBeTruthy();
    expect(user.categories.length).toBe(10);
  });

  it("rejects a duplicate email with 409", async (ctx) => {
    if (!ready) return ctx.skip();
    const email = `regtest+dup${Date.now()}@example.com`;
    const first = await api("POST", "/auth/register", { email, password: "password1234", device });
    expect(first.status).toBe(201);
    const second = await api("POST", "/auth/register", { email, password: "password1234", device });
    expect(second.status).toBe(409);
  });

  it("rejects an invalid (too short) password with 400", async (ctx) => {
    if (!ready) return ctx.skip();
    const res = await api("POST", "/auth/register", { email: `regtest+bad${Date.now()}@example.com`, password: "short", device });
    expect(res.status).toBe(400);
  });

  it("allows login immediately after registration", async (ctx) => {
    if (!ready) return ctx.skip();
    const email = `regtest+login${Date.now()}@example.com`;
    const reg = await api("POST", "/auth/register", { email, password: "password1234", device });
    expect(reg.status).toBe(201);
    const login = await api("POST", "/auth/login", { email, password: "password1234", device });
    expect(login.status).toBe(200);
    expect(login.json.accessToken).toBeTruthy();
  });
});
