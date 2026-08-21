import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Transaction Intelligence Engine — real device-reported regression cases
// (§14). Kept in its OWN file/server instance (own authLimiter budget) —
// financial-event-intelligence.test.ts already registers enough users on
// its own shared server that adding these here would trip the 20-per-15min
// auth rate limit for the whole file. Opt-in via MOBILE_TEST_DATABASE_URL,
// same pattern as every other integration test file.

let ready = false;
let server: Server | undefined;
let base = "";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;

const EMAIL_TAG = "txnintel+";
let seq = 0;
const device = () => ({ deviceId: `tie-device-${Date.now()}-${seq++}`, platform: "android" as const });

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
  return prisma.bankAccount.create({ data: { userId, bankName: "Test Bank", nickname: "Current", accountType: "CURRENT", currency: "GBP", balanceMinor: openingMinor } });
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

describe("Transaction Intelligence Engine — real regression cases", () => {
  it("CASE A: Zable repayment with GENERIC wording (no 'repayment'/'minimum payment' at all) still reclassifies to CREDIT_CARD_REPAYMENT via account identity", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accessToken } = await register();
    const monzo = await newAccount(userId, 100000n);
    const zable = await prisma.bankAccount.create({
      data: { userId, bankName: "Zable", nickname: "Zable Credit Card", accountType: "CREDIT_CARD", currency: "GBP", balanceMinor: 50000n },
    });

    const res = await auto(accessToken, {
      sourcePackage: "co.uk.monzo",
      title: "Monzo",
      // Deliberately generic — the exact real-device wording gap: no
      // "repayment"/"minimum payment"/"statement balance"/"credit card"
      // anywhere in the text, so only account-identity evidence can catch it.
      redactedSourceText: "Payment to Zable Card has left your account",
      direction: "EXPENSE",
      amountMinor: 25443,
      merchant: "Zable Card",
      accountId: monzo.id,
    });

    expect(res.status).toBe(201);
    expect(res.json.result).toBe("AUTO_IMPORTED");
    expect(res.json.event.eventKind).toBe("CREDIT_CARD_REPAYMENT");
    expect(res.json.event.analyticsRole).toBe("LIABILITY_REPAYMENT");
    expect(res.json.event.fromAccountId).toBe(monzo.id);
    expect(res.json.event.toAccountId).toBe(zable.id);

    const txn = await prisma.transaction.findUnique({ where: { id: res.json.transaction.id } });
    expect(txn.transactionType).toBe("CREDIT_CARD_REPAYMENT");
    expect(txn.recipientAccountId).toBe(zable.id);

    // Never Purchase.
    expect(txn.transactionType).not.toBe("PURCHASE");

    expect(await balance(monzo.id)).toBe(100000n - 25443n);
    expect(await balance(zable.id)).toBe(50000n - 25443n);

    const overview = await api("GET", "/insights/overview", { token: accessToken });
    const gbp = overview.json.summary.currencies.find((c: any) => c.currency === "GBP");
    expect(gbp?.spendingMinor ?? 0).toBe(0); // never counted as spending
  });

  it("CASE D: the same repayment collected via Direct Debit gets paymentRail=DIRECT_DEBIT and attaches to an existing mandate WITHOUT overwriting transactionType", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accessToken } = await register();
    const monzo = await newAccount(userId, 100000n);
    await prisma.bankAccount.create({ data: { userId, bankName: "Zable", nickname: "Zable Credit Card", accountType: "CREDIT_CARD", currency: "GBP", balanceMinor: 50000n } });

    // Pre-alert (existing text-wording detection) seeds the mandate.
    const pre = await auto(accessToken, {
      sourcePackage: "co.uk.monzo", title: "Monzo",
      redactedSourceText: "We'll take your monthly repayment of £254.43 to Zable Card via Direct Debit on August 20th",
      direction: "EXPENSE", amountMinor: 25443, merchant: "Zable Card", accountId: monzo.id,
    });
    expect(pre.json.result).toBe("UPCOMING_RECORDED");
    const mandate = await prisma.directDebitMandate.findFirst({ where: { userId, accountId: monzo.id } });
    expect(mandate).toBeTruthy();

    // The actual payment — generic wording, only "Direct Debit" present.
    const actual = await auto(accessToken, {
      sourcePackage: "co.uk.monzo", title: "Monzo",
      redactedSourceText: "Direct Debit to Zable Card has left your account",
      direction: "EXPENSE", amountMinor: 25443, merchant: "Zable Card", accountId: monzo.id,
    });
    expect(actual.status).toBe(201);
    expect(actual.json.result).toBe("AUTO_IMPORTED");
    expect(actual.json.event.paymentRail).toBe("DIRECT_DEBIT");
    expect(actual.json.event.eventKind).toBe("CREDIT_CARD_REPAYMENT");

    const txn = await prisma.transaction.findUnique({ where: { id: actual.json.transaction.id } });
    expect(txn.transactionType).toBe("CREDIT_CARD_REPAYMENT"); // never DIRECT_DEBIT — never re-included in spending
    expect(txn.directDebitMandateId).toBe(mandate.id); // still visible in Payments -> Direct Debits

    const overview = await api("GET", "/insights/overview", { token: accessToken });
    const gbp = overview.json.summary.currencies.find((c: any) => c.currency === "GBP");
    expect(gbp?.spendingMinor ?? 0).toBe(0);
  });

  it("account-identity resolution is skipped entirely for a genuinely unmapped/ambiguous payee — falls back to ordinary classification, never guesses", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accessToken } = await register();
    const monzo = await newAccount(userId, 100000n);
    // No Zable account exists at all — nothing to resolve against.
    const res = await auto(accessToken, {
      sourcePackage: "co.uk.monzo", title: "Monzo",
      redactedSourceText: "Payment to Zable Card has left your account",
      direction: "EXPENSE", amountMinor: 25443, merchant: "Zable Card", accountId: monzo.id,
    });
    expect(res.status).toBe(201);
    expect(res.json.event.eventKind).not.toBe("CREDIT_CARD_REPAYMENT");
    const txn = await prisma.transaction.findUnique({ where: { id: res.json.transaction.id } });
    expect(txn.transactionType).not.toBe("CREDIT_CARD_REPAYMENT");
  });

  it("CASE B: an owned-account credit is provisionally REVIEW, not locked as income, when a name-matching own account exists", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accessToken } = await register();
    const halifax = await newAccount(userId, 50000n);
    await prisma.bankAccount.create({ data: { userId, bankName: "Monzo", nickname: "Monzo", accountType: "CURRENT", currency: "GBP", balanceMinor: 100000n, accountHolderName: "Sardar Saeed" } });

    const res = await auto(accessToken, {
      sourcePackage: "unknown.halifax", title: "Halifax",
      redactedSourceText: "SARDAR SAEED is now in your account ending 4321",
      direction: "INCOME", amountMinor: 200, senderName: "SARDAR SAEED", accountId: halifax.id,
    });
    expect(res.status).toBe(201);
    // Money did arrive — it IS posted (Halifax's own notification is trusted
    // evidence of a real credit) — but the ANALYTICS role must not lock in
    // as income while account-identity evidence suggests a same-user transfer.
    expect(res.json.event.analyticsRole).toBe("REVIEW");
    expect(res.json.event.analyticsRole).not.toBe("INCOME");
  });

  it("CASE B: once the matching debit exists on another owned account, both sides reconcile to INTERNAL_TRANSFER via the existing pairing engine", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accessToken } = await register();
    const halifax = await newAccount(userId, 50000n);
    const monzo = await prisma.bankAccount.create({ data: { userId, bankName: "Monzo", nickname: "Monzo", accountType: "CURRENT", currency: "GBP", balanceMinor: 100000n, accountHolderName: "Sardar Saeed" } });

    const credit = await auto(accessToken, {
      sourcePackage: "unknown.halifax", title: "Halifax",
      redactedSourceText: "SARDAR SAEED is now in your account ending 4321",
      direction: "INCOME", amountMinor: 200, senderName: "SARDAR SAEED", accountId: halifax.id,
    });
    expect(credit.status).toBe(201);

    const debit = await auto(accessToken, {
      sourcePackage: "co.uk.monzo", title: "Monzo",
      redactedSourceText: "You sent £2.00 to SARDAR SAEED",
      direction: "EXPENSE", amountMinor: 200, recipientName: "SARDAR SAEED", accountId: monzo.id,
    });
    expect(debit.status).toBe(201);

    const creditTxn = await prisma.transaction.findUnique({ where: { id: credit.json.transaction.id } });
    const debitTxn = await prisma.transaction.findUnique({ where: { id: debit.json.transaction.id } });
    expect(creditTxn.transactionType).toBe("INTERNAL_TRANSFER");
    expect(debitTxn.transactionType).toBe("INTERNAL_TRANSFER");
    expect(creditTxn.internalTransferGroupId).toBe(debitTxn.internalTransferGroupId);

    // No longer counted as income.
    const overview = await api("GET", "/insights/overview", { token: accessToken });
    const gbp = overview.json.summary.currencies.find((c: any) => c.currency === "GBP");
    expect(gbp?.incomeMinor ?? 0).toBe(0);
  });

  it("a genuine incoming salary (no owned-account match at all) remains ordinary INCOME, never REVIEW", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accessToken } = await register();
    const halifax = await newAccount(userId, 50000n);
    const res = await auto(accessToken, {
      sourcePackage: "unknown.halifax", title: "Halifax",
      redactedSourceText: "ACME PAYROLL LTD has paid £1,850.00 into your account ending 4321",
      direction: "INCOME", amountMinor: 185000, senderName: "ACME PAYROLL LTD", accountId: halifax.id,
    });
    expect(res.status).toBe(201);
    expect(res.json.event.analyticsRole).toBe("INCOME");
    const overview = await api("GET", "/insights/overview", { token: accessToken });
    const gbp = overview.json.summary.currencies.find((c: any) => c.currency === "GBP");
    expect(gbp.incomeMinor).toBeGreaterThanOrEqual(185000);
  });

  it("CASE C: Capital One / AliExpress pending purchase still resolves account ownership and reconciles pending -> completed exactly once through the same engine", async (ctx) => {
    if (!ready) return ctx.skip();
    const { userId, accessToken } = await register();
    const capitalOne = await newAccount(userId, 0n);

    const pending = await auto(accessToken, {
      sourcePackage: "com.ie.capitalone.uk", title: "ALIEXPRESS.COM",
      redactedSourceText: "£2.55 on card ending 7813. That leaves £202.51 available to spend",
      direction: "EXPENSE", amountMinor: 255, merchant: "ALIEXPRESS.COM", accountId: capitalOne.id,
    });
    expect(pending.status).toBe(201);
    expect(pending.json.event.lifecycle).toBe("PENDING");
    expect(pending.json.transaction).toBeNull(); // never booked while pending
    expect(await balance(capitalOne.id)).toBe(0n);

    const settled = await auto(accessToken, {
      sourcePackage: "com.ie.capitalone.uk", title: "ALIEXPRESS.COM",
      redactedSourceText: "You spent £2.55 at ALIEXPRESS.COM",
      direction: "EXPENSE", amountMinor: 255, merchant: "ALIEXPRESS.COM", accountId: capitalOne.id,
    });
    expect(settled.status).toBe(201);
    expect(settled.json.result).toBe("AUTO_IMPORTED");

    // Exactly one FinancialEvent transitioned PENDING -> COMPLETED, never two.
    const events = await prisma.financialEvent.findMany({ where: { userId, accountId: capitalOne.id, merchantName: "ALIEXPRESS.COM" } });
    expect(events.length).toBe(1);
    expect(events[0].lifecycle).toBe("COMPLETED");

    const txns = await prisma.transaction.count({ where: { userId, accountId: capitalOne.id } });
    expect(txns).toBe(1); // exactly one canonical transaction, never duplicated
    expect(await balance(capitalOne.id)).toBe(-255n);
  });
});
