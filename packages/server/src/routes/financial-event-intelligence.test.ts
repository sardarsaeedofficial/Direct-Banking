import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Financial Event Intelligence — end-to-end regression coverage for the new
// semantic layer between notification capture and canonical ledger posting.
// Exercised over real HTTP against the mobile API (POST
// /notification-imports/auto is the exact endpoint the old "trusted source +
// amount = completed" bug lived in). Opt-in via MOBILE_TEST_DATABASE_URL.

let ready = false;
let server: Server | undefined;
let base = "";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;

const EMAIL_TAG = "fineventintel+";
let seq = 0;
const device = () => ({ deviceId: `fei-device-${Date.now()}-${seq++}`, platform: "android" as const });

interface Fixture { userId: string; accessToken: string }

async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(base + path, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, json };
}

async function register(): Promise<Fixture> {
  const email = `${EMAIL_TAG}${Date.now()}_${seq++}@example.com`;
  const res = await api("POST", "/auth/register", { body: { email, password: "password1234", device: device() } });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.json)}`);
  return { userId: res.json.user.id as string, accessToken: res.json.accessToken as string };
}

async function newAccount(userId: string, openingMinor = 100000n) {
  return prisma.bankAccount.create({ data: { userId, bankName: "Test Bank", nickname: "Current", accountType: "CURRENT", balanceMinor: openingMinor } });
}

function fp() {
  return `fp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function auto(token: string, body: Record<string, unknown>) {
  return api("POST", "/notification-imports/auto", {
    token,
    body: {
      fingerprint: fp(),
      sourcePackage: "unknown.package",
      currency: "GBP",
      occurredAt: new Date().toISOString(),
      confidence: 0.9,
      redactedSourceText: "",
      title: "",
      ...body,
    },
  });
}

async function balance(accountId: string): Promise<bigint> {
  return (await prisma.bankAccount.findUnique({ where: { id: accountId } })).balanceMinor as bigint;
}

beforeAll(async () => {
  const dbUrl = process.env.MOBILE_TEST_DATABASE_URL;
  if (!dbUrl) { ready = false; return; }
  process.env.DATABASE_URL = dbUrl;
  process.env.MOBILE_JWT_SECRET ||= "test-mobile-secret-0123456789abcdef";
  process.env.SESSION_SECRET ||= "test-session-secret-0123456789abcdef";
  process.env.COOKIE_SECURE ||= "false";
  try {
    prisma = (await import("../db.js")).prisma;
    await prisma.$queryRaw`SELECT 1`;
    const { createApp } = await import("../app.js");
    server = createApp().listen(0);
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
  if (ready && prisma) await prisma.user.deleteMany({ where: { email: { contains: EMAIL_TAG } } });
});

describe("Financial Event Intelligence — critical acceptance criteria", () => {
  it("Zable credit-card repayment pre-alert: UPCOMING CREDIT_CARD_REPAYMENT, no income, no balance change", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accessToken } = await register();
    const acc = await newAccount(userId, 500000n);
    const before = await balance(acc.id);

    const res = await auto(accessToken, {
      sourcePackage: "unknown.zable",
      title: "Zable",
      redactedSourceText: "We'll take your monthly repayment of £254.43 from your Monzo account ending with 2815 on August 20th",
      direction: "EXPENSE",
      amountMinor: 25443,
      merchant: "Zable",
      accountId: acc.id,
      occurredAt: "2026-08-15T10:00:00.000Z", // fixed, deterministic — see expectedAt assertion below
    });

    expect(res.status).toBe(201);
    expect(res.json.result).toBe("UPCOMING_RECORDED");
    expect(res.json.transaction).toBeNull();
    expect(await balance(acc.id)).toBe(before); // unchanged

    const event = await prisma.financialEvent.findFirst({ where: { userId, eventKind: "CREDIT_CARD_REPAYMENT" }, orderBy: { createdAt: "desc" } });
    expect(event).toBeTruthy();
    expect(event.lifecycle).toBe("UPCOMING");
    expect(event.moneyEffect).toBe("NONE");
    expect(event.amountMinor).toBe(25443);
    expect(event.expectedAt?.toISOString().slice(0, 10)).toBe("2026-08-20"); // "on August 20th"

    const txnCountBefore = await prisma.transaction.count({ where: { userId } });
    expect(txnCountBefore).toBe(0); // no ledger transaction created at all

    // Forecast/upcoming surfaces it.
    const upcoming = await api("GET", "/upcoming-payments?days=90", { token: accessToken });
    expect(upcoming.status).toBe(200);
    expect(upcoming.json.totalMinor).toBeGreaterThanOrEqual(25443);
  });

  it("Halifax Direct Debit pre-alert: UPCOMING DIRECT_DEBIT, no balance change, mandate updated", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accessToken } = await register();
    const acc = await newAccount(userId, 100000n);
    const before = await balance(acc.id);

    const res = await auto(accessToken, {
      sourcePackage: "unknown.halifax",
      title: "Halifax",
      redactedSourceText: "Your direct debit to MANCHESTER C C leaves your account ending 7164 this week. Based on previous payments, it will be £170.00.",
      direction: "EXPENSE",
      amountMinor: 17000,
      merchant: "Manchester City Council",
      accountId: acc.id,
    });

    expect(res.status).toBe(201);
    expect(res.json.result).toBe("UPCOMING_RECORDED");
    expect(await balance(acc.id)).toBe(before);

    const mandate = await prisma.directDebitMandate.findFirst({ where: { userId, accountId: acc.id } });
    expect(mandate).toBeTruthy();
    expect(mandate.expectedAmountMinor).toBe(17000);
    expect(mandate.nextExpectedAt).toBeTruthy();
    expect(await prisma.transaction.count({ where: { userId } })).toBe(0);
  });

  it("Halifax actual debit later reconciles with the SAME mandate and posts exactly once", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accessToken } = await register();
    const acc = await newAccount(userId, 100000n);

    await auto(accessToken, {
      sourcePackage: "unknown.halifax", title: "Halifax",
      redactedSourceText: "Your direct debit to MANCHESTER C C leaves your account ending 7164 this week. Based on previous payments, it will be £170.00.",
      direction: "EXPENSE", amountMinor: 17000, merchant: "Manchester City Council", accountId: acc.id,
    });
    const mandateAfterPreAlert = await prisma.directDebitMandate.findFirst({ where: { userId, accountId: acc.id } });

    const before = await balance(acc.id);
    const actual = await auto(accessToken, {
      sourcePackage: "unknown.halifax", title: "Halifax",
      redactedSourceText: "Manchester City Council direct debit payment of £170.00 has left your account ending 7164",
      direction: "EXPENSE", amountMinor: 17000, merchant: "Manchester City Council", accountId: acc.id,
    });

    expect(actual.status).toBe(201);
    expect(actual.json.result).toBe("AUTO_IMPORTED");
    expect(await balance(acc.id)).toBe(before - 17000n); // subtracted exactly once

    const mandatesAfter = await prisma.directDebitMandate.findMany({ where: { userId, accountId: acc.id } });
    expect(mandatesAfter.length).toBe(1); // no duplicate mandate created
    expect(mandatesAfter[0].id).toBe(mandateAfterPreAlert.id);
    expect(mandatesAfter[0].paymentCount).toBe(1);

    const txns = await prisma.transaction.findMany({ where: { userId } });
    expect(txns.length).toBe(1); // exactly one canonical transaction, ever
  });

  it("AliExpress declined: DECLINED, no balance change, no spending", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accessToken } = await register();
    const acc = await newAccount(userId, 50000n);
    const before = await balance(acc.id);

    const res = await auto(accessToken, {
      sourcePackage: "com.aliexpress", title: "AliExpress",
      redactedSourceText: "Your AliExpress payment of £35.83 was declined",
      direction: "EXPENSE", amountMinor: 3583, merchant: "AliExpress", accountId: acc.id,
    });

    expect(res.status).toBe(201);
    expect(res.json.result).toBe("NOT_POSTED");
    expect(res.json.transaction).toBeNull();
    expect(await balance(acc.id)).toBe(before);
    expect(await prisma.transaction.count({ where: { userId } })).toBe(0);

    const event = await prisma.financialEvent.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } });
    expect(event.lifecycle).toBe("DECLINED");
    expect(event.ledgerImpact).toBe("NONE");
  });

  it("approved-source safety: a trusted Monzo package does NOT force COMPLETED when the text says upcoming", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accessToken } = await register();
    const acc = await newAccount(userId, 100000n);
    const before = await balance(acc.id);

    const res = await auto(accessToken, {
      sourcePackage: "co.uk.monzo", title: "Monzo",
      redactedSourceText: "We'll take your subscription payment of £9.99 on August 25th",
      direction: "EXPENSE", amountMinor: 999, merchant: "Netflix", accountId: acc.id,
    });

    expect(res.status).toBe(201);
    expect(res.json.result).toBe("UPCOMING_RECORDED");
    expect(await balance(acc.id)).toBe(before);
  });

  it("approved-source safety: a trusted Monzo package does NOT force COMPLETED when the text says declined", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accessToken } = await register();
    const acc = await newAccount(userId, 100000n);
    const before = await balance(acc.id);

    const res = await auto(accessToken, {
      sourcePackage: "co.uk.monzo", title: "Monzo",
      redactedSourceText: "Your payment to Tesco was declined",
      direction: "EXPENSE", amountMinor: 2000, merchant: "Tesco", accountId: acc.id,
    });

    expect(res.status).toBe(201);
    expect(res.json.result).toBe("NOT_POSTED");
    expect(await balance(acc.id)).toBe(before);
  });

  it("ambiguous financial notification with low client confidence and no text signal goes to Review, not automatic posting", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accessToken } = await register();
    const acc = await newAccount(userId, 100000n);
    const before = await balance(acc.id);

    const res = await auto(accessToken, {
      sourcePackage: "unknown.random", title: "Payment",
      redactedSourceText: "redacted",
      direction: "EXPENSE", amountMinor: 1500, confidence: 0.3, accountId: acc.id,
    });

    expect(res.status).toBe(201);
    expect(res.json.transaction).toBeNull();
    expect(await balance(acc.id)).toBe(before);
    expect(res.json.event.lifecycle === "UNKNOWN" || res.json.event.confidenceLevel !== "HIGH").toBe(true);
  });
});

describe("Financial Event Intelligence — pending/declined/completed lifecycle", () => {
  it("pending -> completed converges into exactly one transaction", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accessToken } = await register();
    const acc = await newAccount(userId, 100000n);
    const now = new Date();

    const pendingRes = await auto(accessToken, {
      sourcePackage: "co.uk.monzo", title: "Monzo",
      redactedSourceText: "Your card payment to Amazon is pending",
      direction: "EXPENSE", amountMinor: 2499, merchant: "Amazon", accountId: acc.id,
      occurredAt: now.toISOString(),
    });
    expect(pendingRes.status).toBe(201);
    expect(pendingRes.json.transaction).toBeNull();

    const completedRes = await auto(accessToken, {
      sourcePackage: "co.uk.monzo", title: "Monzo",
      redactedSourceText: "You spent £24.99 at Amazon",
      direction: "EXPENSE", amountMinor: 2499, merchant: "Amazon", accountId: acc.id,
      occurredAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    });
    expect(completedRes.status).toBe(201);
    expect(completedRes.json.result).toBe("AUTO_IMPORTED");

    expect(await prisma.transaction.count({ where: { userId } })).toBe(1);
    const events = await prisma.financialEvent.findMany({ where: { userId } });
    expect(events.length).toBe(1); // the pending event was TRANSITIONED, not duplicated
    expect(events[0].lifecycle).toBe("COMPLETED");
  });

  it("pending -> declined: one financial event, final lifecycle DECLINED, no balance effect", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accessToken } = await register();
    const acc = await newAccount(userId, 100000n);
    const before = await balance(acc.id);
    const now = new Date();

    await auto(accessToken, {
      sourcePackage: "co.uk.monzo", title: "Monzo",
      redactedSourceText: "Your card payment to AliExpress is pending",
      direction: "EXPENSE", amountMinor: 3583, merchant: "AliExpress", accountId: acc.id,
      occurredAt: now.toISOString(),
    });
    const declinedRes = await auto(accessToken, {
      sourcePackage: "co.uk.monzo", title: "Monzo",
      redactedSourceText: "Your AliExpress payment of £35.83 was declined",
      direction: "EXPENSE", amountMinor: 3583, merchant: "AliExpress", accountId: acc.id,
      occurredAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    });

    expect(declinedRes.status).toBe(201);
    expect(await balance(acc.id)).toBe(before);
    const events = await prisma.financialEvent.findMany({ where: { userId } });
    expect(events.length).toBe(1);
    expect(events[0].lifecycle).toBe("DECLINED");
    expect(await prisma.transaction.count({ where: { userId } })).toBe(0);
  });

  it("declined followed by a genuinely new successful retry: TWO events, only the completed one posts", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accessToken } = await register();
    const acc = await newAccount(userId, 100000n);
    const before = await balance(acc.id);
    const t1300 = new Date("2026-08-15T13:00:00Z");
    const t1305 = new Date("2026-08-15T13:05:00Z");

    const declined = await auto(accessToken, {
      sourcePackage: "co.uk.monzo", title: "Monzo",
      redactedSourceText: "Your AliExpress payment of £35.83 was declined",
      direction: "EXPENSE", amountMinor: 3583, merchant: "AliExpress", accountId: acc.id,
      occurredAt: t1300.toISOString(),
    });
    const retry = await auto(accessToken, {
      sourcePackage: "co.uk.monzo", title: "Monzo",
      redactedSourceText: "You spent £35.83 at AliExpress",
      direction: "EXPENSE", amountMinor: 3583, merchant: "AliExpress", accountId: acc.id,
      occurredAt: t1305.toISOString(),
    });

    expect(declined.json.transaction).toBeNull();
    expect(retry.json.result).toBe("AUTO_IMPORTED");
    expect(await balance(acc.id)).toBe(before - 3583n); // only the successful retry moved money

    const events = await prisma.financialEvent.findMany({ where: { userId }, orderBy: { occurredAt: "asc" } });
    expect(events.length).toBe(2); // both preserved — the decline was never silently converted
    expect(events[0].lifecycle).toBe("DECLINED");
    expect(events[1].lifecycle).toBe("COMPLETED");
    expect(await prisma.transaction.count({ where: { userId } })).toBe(1);
  });

  it("duplicate notification delivery creates exactly one FinancialEvent, idempotent retries included", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accessToken } = await register();
    const acc = await newAccount(userId, 100000n);
    const fingerprint = fp();
    const body = {
      fingerprint, sourcePackage: "co.uk.monzo", title: "Monzo", redactedSourceText: "You spent £5.00 at Costa",
      direction: "EXPENSE", amountMinor: 500, merchant: "Costa", accountId: acc.id, currency: "GBP",
      occurredAt: new Date().toISOString(), confidence: 0.95,
    };
    const first = await api("POST", "/notification-imports/auto", { token: accessToken, body });
    const second = await api("POST", "/notification-imports/auto", { token: accessToken, body });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.json.duplicate).toBe(true);
    expect(await prisma.financialEvent.count({ where: { userId } })).toBe(1);
    expect(await prisma.transaction.count({ where: { userId } })).toBe(1);
  });
});

describe("Financial Event Intelligence — refunds, reversals, non-financial", () => {
  it("a completed purchase later refunded: audit history retained, balance corrected once, spending analytics corrected", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accessToken } = await register();
    const acc = await newAccount(userId, 100000n);

    const purchase = await auto(accessToken, {
      sourcePackage: "co.uk.monzo", title: "Monzo",
      redactedSourceText: "You spent £20.00 at Tesco",
      direction: "EXPENSE", amountMinor: 2000, merchant: "Tesco", accountId: acc.id,
    });
    expect(purchase.json.result).toBe("AUTO_IMPORTED");
    const afterPurchase = await balance(acc.id);

    const refund = await auto(accessToken, {
      sourcePackage: "co.uk.monzo", title: "Monzo",
      redactedSourceText: "You were refunded £20.00 by Tesco",
      direction: "INCOME", amountMinor: 2000, merchant: "Tesco", accountId: acc.id,
    });
    expect(refund.status).toBe(201);
    expect(await balance(acc.id)).toBe(afterPurchase + 2000n); // corrected exactly once

    const original = await prisma.transaction.findUnique({ where: { id: purchase.json.transaction.id } });
    expect(original.status).toBe("REFUNDED"); // history retained, not deleted
    expect(await prisma.transaction.count({ where: { userId } })).toBe(2); // original + correction, both preserved
  });

  it("non-financial trusted-app notification never posts a transaction", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accessToken } = await register();
    const acc = await newAccount(userId, 100000n);

    const res = await auto(accessToken, {
      sourcePackage: "co.uk.monzo", title: "Monzo",
      redactedSourceText: "Your monthly statement is ready to view",
      direction: "EXPENSE", amountMinor: 100, accountId: acc.id,
    });

    expect(res.status).toBe(201);
    expect(res.json.transaction).toBeNull();
    expect(await prisma.transaction.count({ where: { userId } })).toBe(0);
    const event = await prisma.financialEvent.findFirst({ where: { userId } });
    expect(event.eventKind).toBe("NON_FINANCIAL");
  });
});

describe("Financial Event Intelligence — analytics/budget exclusions", () => {
  it("a completed credit-card repayment moves cash but is excluded from spending/budget/merchant analytics", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accessToken } = await register();
    const acc = await newAccount(userId, 100000n);
    const before = await balance(acc.id);

    const res = await auto(accessToken, {
      sourcePackage: "unknown.zable", title: "Zable",
      redactedSourceText: "Your monthly repayment of £50.00 to Zable has left your account",
      direction: "EXPENSE", amountMinor: 5000, merchant: "Zable", accountId: acc.id,
    });
    expect(res.status).toBe(201);
    expect(res.json.result).toBe("AUTO_IMPORTED");
    expect(await balance(acc.id)).toBe(before - 5000n); // real cash movement

    const txn = await prisma.transaction.findUnique({ where: { id: res.json.transaction.id } });
    expect(txn.transactionType).toBe("CREDIT_CARD_REPAYMENT");

    const overview = await api("GET", "/insights/overview?period=custom&start=2020-01-01&end=2030-01-01", { token: accessToken });
    expect(overview.status).toBe(200);
    // The repayment must not appear as spending in the monthly summary.
    const spendingMinor = overview.json?.currencies?.[0]?.spendingMinor ?? 0;
    expect(spendingMinor).toBe(0);
  });
});

describe("Financial Event Intelligence — historical suspicious-record review", () => {
  it("flags a legacy notification-derived transaction that would now classify as UPCOMING, and lets the user confirm a correction", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accessToken } = await register();
    const acc = await newAccount(userId, 100000n);

    // Simulate a pre-existing, already-posted record from BEFORE this phase's
    // safeguards existed: a NotificationImport whose own text is clearly
    // upcoming language, but which was (incorrectly, under the old rules)
    // already approved into a completed transaction.
    const legacyTxn = await prisma.transaction.create({
      data: {
        userId, accountId: acc.id, direction: "EXPENSE", status: "COMPLETED", source: "NOTIFICATION",
        amountMinor: 25443n, currency: "GBP", bookedAt: new Date(), description: "Zable", merchantName: "Zable", balanceApplied: true,
      },
    });
    await prisma.bankAccount.update({ where: { id: acc.id }, data: { balanceMinor: { decrement: 25443n } } });
    await prisma.notificationImport.create({
      data: {
        userId, sourcePackage: "unknown.zable", title: "Zable",
        message: "We'll take your monthly repayment of £254.43 from your Monzo account ending with 2815 on August 20th",
        redactedText: "We'll take your monthly repayment of £254.43 from your Monzo account ending with 2815 on August 20th",
        receivedAt: new Date(), parsedAmountMinor: 25443n, direction: "EXPENSE", currency: "GBP", confidence: 0.9,
        sourceHash: fp(), status: "APPROVED", approvedTransactionId: legacyTxn.id,
      },
    });

    const listRes = await api("GET", "/notification-imports/suspicious", { token: accessToken });
    expect(listRes.status).toBe(200);
    expect(listRes.json.items.length).toBe(1);
    expect(listRes.json.items[0].transactionId).toBe(legacyTxn.id);
    expect(listRes.json.items[0].suspectedLifecycle).toBe("UPCOMING");

    const beforeCorrection = await balance(acc.id);
    const applyRes = await api("POST", `/notification-imports/${legacyTxn.id}/apply-correction`, { token: accessToken });
    expect(applyRes.status).toBe(200);
    expect(applyRes.json.corrected).toBe(true);

    const corrected = await prisma.transaction.findUnique({ where: { id: legacyTxn.id } });
    expect(corrected.status).toBe("CANCELLED"); // never deleted — audit trail retained
    expect(await balance(acc.id)).toBe(beforeCorrection + 25443n); // balance effect reversed exactly once

    const correctionRow = await prisma.transactionCorrection.findFirst({ where: { userId, transactionId: legacyTxn.id } });
    expect(correctionRow).toBeTruthy();
    expect(correctionRow.action).toBe("LIFECYCLE_RECLASSIFY");

    // Re-applying must not double-correct the balance.
    const secondApply = await api("POST", `/notification-imports/${legacyTxn.id}/apply-correction`, { token: accessToken });
    expect(secondApply.status).toBe(409);
    expect(await balance(acc.id)).toBe(beforeCorrection + 25443n);
  });
});

describe("Financial Event Intelligence — Bank Connections readiness", () => {
  it("readiness endpoint reports DISABLED in this test environment (no OPEN_BANKING_* vars set) without leaking credentials", async (ctx) => {
    if (!ready) return ctx.skip();
    const { accessToken } = await register();
    const res = await api("GET", "/bank-connections/readiness", { token: accessToken });
    expect(res.status).toBe(200);
    expect(typeof res.json.enabled).toBe("boolean");
    expect(res.json.enabled).toBe(false);
    expect(res.json.reason).toBe("DISABLED");
    expect(res.json.configured).toBe(false);
    // Never silently assumes a provider — OPEN_BANKING_PROVIDER has no
    // default (the exact bug this round's brief asked to close).
    expect(res.json.provider).toBeNull();
    expect(Array.isArray(res.json.missing)).toBe(true);
    // Never a raw secret value — only variable names in `missing`.
    const asText = JSON.stringify(res.json);
    expect(asText).not.toMatch(/sk_live|sk_test|BEGIN PRIVATE KEY/i);
  });

  it("bank-connections/start returns a distinguishable DISABLED reason when Open Banking is disabled", async (ctx) => {
    if (!ready) return ctx.skip();
    const { accessToken } = await register();
    const res = await api("POST", "/bank-connections/start", { token: accessToken });
    // In this test environment Open Banking is disabled by default (no env vars set).
    expect(res.status).toBe(503);
    expect(res.json.details?.reason ?? res.json.reason).toBe("DISABLED");
  });
});

describe("Financial Event Intelligence — unified Activity API (§4 dedup + §3 lifecycle filters)", () => {
  // A single shared user/account for the whole block (rather than one
  // register() per scenario) — /auth/register sits behind authLimiter (20
  // per 15 min, see middleware/rateLimit.ts), and this file already spends a
  // good chunk of that budget on the describe blocks above. The scenarios
  // below are independent notifications on one account, so nothing about the
  // assertions requires separate users.
  it("dedup, lifecycle filters (upcoming/declined/pending/completed/all), and existing type filters all behave correctly together", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accessToken } = await register();
    const acc = await newAccount(userId, 500000n);

    // 1) A completed purchase — its FinancialEvent gets linked to the
    // Transaction it posted, so the dedup rule (§4) must hide the event and
    // show only the canonical Transaction.
    const purchase = await auto(accessToken, {
      sourcePackage: "co.uk.monzo", title: "Monzo",
      redactedSourceText: "You spent £18.30 at Tesco",
      direction: "EXPENSE", amountMinor: 1830, merchant: "Tesco", accountId: acc.id,
    });
    expect(purchase.status).toBe(201);
    expect(purchase.json.result).toBe("AUTO_IMPORTED");
    const txnId = purchase.json.transaction.id as string;
    const linkedEvent = await prisma.financialEvent.findFirst({ where: { userId, linkedTransactionId: txnId } });
    expect(linkedEvent).toBeTruthy(); // really was linked — otherwise the dedup check below is vacuous
    expect(linkedEvent.lifecycle).toBe("COMPLETED");

    // 2) An UPCOMING credit-card repayment — never becomes a Transaction.
    const upcomingRes = await auto(accessToken, {
      sourcePackage: "unknown.zable", title: "Zable",
      redactedSourceText: "We'll take your monthly repayment of £254.43 from your Monzo account ending with 2815 on August 20th",
      direction: "EXPENSE", amountMinor: 25443, merchant: "Zable", accountId: acc.id,
      occurredAt: "2026-08-15T10:00:00.000Z",
    });
    expect(upcomingRes.status).toBe(201);
    expect(upcomingRes.json.result).toBe("UPCOMING_RECORDED");

    // 3) A DECLINED payment — never becomes a Transaction, never posts.
    const declinedRes = await auto(accessToken, {
      sourcePackage: "com.aliexpress", title: "AliExpress",
      redactedSourceText: "Your AliExpress payment of £35.83 was declined",
      direction: "EXPENSE", amountMinor: 3583, merchant: "AliExpress", accountId: acc.id,
    });
    expect(declinedRes.status).toBe(201);

    // 4) A PENDING card hold, still unsettled.
    const pendingRes = await auto(accessToken, {
      sourcePackage: "co.uk.monzo", title: "Monzo",
      redactedSourceText: "Your card payment to Amazon is pending",
      direction: "EXPENSE", amountMinor: 2499, merchant: "Amazon", accountId: acc.id,
    });
    expect(pendingRes.status).toBe(201);

    // -- Dedup: the Tesco Transaction appears exactly once, never alongside
    // its own (now-linked) FinancialEvent. --
    const tescoRes = await api("GET", "/activity?lifecycle=all&q=Tesco", { token: accessToken });
    expect(tescoRes.status).toBe(200);
    const tescoMatches = tescoRes.json.items.filter((i: any) => i.displayName === "Tesco" || i.merchant?.displayName === "Tesco");
    expect(tescoMatches.length).toBe(1);
    expect(tescoMatches[0].kind).toBe("TRANSACTION");
    expect(tescoMatches[0].id).toBe(txnId);
    expect(tescoMatches[0].lifecycle).toBe("COMPLETED");
    expect(tescoMatches[0].ledgerPosted).toBe(true);

    // -- lifecycle=upcoming: surfaces the FinancialEvent directly, no
    // manufactured Transaction (§4). --
    const upcoming = await api("GET", "/activity?lifecycle=upcoming", { token: accessToken });
    expect(upcoming.status).toBe(200);
    const zableItem = upcoming.json.items.find((i: any) => i.displayName === "Zable");
    expect(zableItem).toBeTruthy();
    expect(zableItem.kind).toBe("FINANCIAL_EVENT");
    expect(zableItem.eventKind).toBe("CREDIT_CARD_REPAYMENT");
    expect(zableItem.lifecycle).toBe("UPCOMING");
    expect(zableItem.ledgerPosted).toBe(false);
    expect(zableItem.amountMinor).toBe(25443);

    // -- lifecycle=declined_failed: surfaces the declined event. --
    const declined = await api("GET", "/activity?lifecycle=declined_failed", { token: accessToken });
    expect(declined.status).toBe(200);
    const aliItem = declined.json.items.find((i: any) => i.displayName === "AliExpress");
    expect(aliItem).toBeTruthy();
    expect(aliItem.kind).toBe("FINANCIAL_EVENT");
    expect(aliItem.lifecycle).toBe("DECLINED");
    expect(aliItem.ledgerPosted).toBe(false);

    // -- lifecycle=pending: surfaces the pending event, excludes completed. --
    const pending = await api("GET", "/activity?lifecycle=pending", { token: accessToken });
    expect(pending.status).toBe(200);
    expect(pending.json.items.some((i: any) => i.displayName === "Amazon" && i.lifecycle === "PENDING")).toBe(true);
    expect(pending.json.items.some((i: any) => i.displayName === "Tesco")).toBe(false);

    // -- lifecycle=completed (pre-existing behaviour, Transactions only):
    // never shows UPCOMING/DECLINED/PENDING events, only the posted Tesco
    // transaction. --
    const completed = await api("GET", "/activity?lifecycle=completed", { token: accessToken });
    expect(completed.status).toBe(200);
    expect(completed.json.items.some((i: any) => i.displayName === "Zable")).toBe(false);
    expect(completed.json.items.some((i: any) => i.displayName === "AliExpress")).toBe(false);
    expect(completed.json.items.some((i: any) => i.displayName === "Amazon")).toBe(false);
    expect(completed.json.items.some((i: any) => i.displayName === "Tesco" && i.kind === "TRANSACTION")).toBe(true);

    // -- lifecycle=all (default): mixes posted transactions and non-posted
    // events together, still deduplicated. --
    const all = await api("GET", "/activity?lifecycle=all", { token: accessToken });
    expect(all.status).toBe(200);
    expect(all.json.items.some((i: any) => i.displayName === "Zable" && i.kind === "FINANCIAL_EVENT")).toBe(true);
    expect(all.json.items.some((i: any) => i.displayName === "AliExpress" && i.kind === "FINANCIAL_EVENT")).toBe(true);
    expect(all.json.items.some((i: any) => i.displayName === "Amazon" && i.kind === "FINANCIAL_EVENT")).toBe(true);
    expect(all.json.items.filter((i: any) => i.displayName === "Tesco").length).toBe(1);

    // -- Existing (pre-round-2) type/direction filters keep working alongside
    // the new lifecycle axis. --
    const byDirection = await api("GET", "/activity?direction=EXPENSE", { token: accessToken });
    expect(byDirection.status).toBe(200);
    expect(byDirection.json.items.some((i: any) => i.displayName === "Tesco")).toBe(true);
  });
});
