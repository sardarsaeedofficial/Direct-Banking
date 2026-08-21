import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Transaction Intelligence Engine (§15) — historical economic-purpose
// re-evaluation. Own file/server (own auth-rate-limit budget), same pattern
// as transaction-intelligence-engine.test.ts. Opt-in via
// MOBILE_TEST_DATABASE_URL.

let ready = false;
let server: Server | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let findSuspiciousEconomicPurpose: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let findRepaymentsMissingMandate: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let linkCreditCardRepaymentToMandate: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let normaliseCompany: any;

beforeAll(async () => {
  const dbUrl = process.env.MOBILE_TEST_DATABASE_URL;
  if (!dbUrl) return;
  process.env.DATABASE_URL = dbUrl;
  process.env.MOBILE_JWT_SECRET ||= "test-mobile-secret-0123456789abcdef";
  process.env.SESSION_SECRET ||= "test-session-secret-0123456789abcdef";
  try {
    prisma = (await import("../../db.js")).prisma;
    await prisma.$queryRaw`SELECT 1`;
    const mod = await import("./historical-review.service.js");
    findSuspiciousEconomicPurpose = mod.findSuspiciousEconomicPurpose;
    findRepaymentsMissingMandate = mod.findRepaymentsMissingMandate;
    const feMod = await import("./financial-event.service.js");
    linkCreditCardRepaymentToMandate = feMod.linkCreditCardRepaymentToMandate;
    normaliseCompany = (await import("../direct-debit.service.js")).normaliseCompany;
    server = (await import("../../app.js")).createApp().listen(0);
    await new Promise((r) => server!.once("listening", r));
    ready = true;
  } catch {
    ready = false;
  }
});

afterAll(async () => {
  if (server) server.close();
  if (ready && prisma) await prisma.user.deleteMany({ where: { email: { contains: "purposereview+" } } });
});

async function newUser(tag: string) {
  const email = `purposereview+${tag}${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`.toLowerCase();
  const user = await prisma.user.create({ data: { email, passwordHash: "x" } });
  return user.id as string;
}

async function newAccount(userId: string, over: Partial<{ bankName: string; nickname: string; accountType: string; balanceMinor: bigint }> = {}) {
  const acc = await prisma.bankAccount.create({
    data: { userId, bankName: over.bankName ?? "Test Bank", nickname: over.nickname ?? over.bankName ?? "Test Bank", accountType: (over.accountType as never) ?? "CURRENT", currency: "GBP", balanceMinor: over.balanceMinor ?? 0n },
  });
  return acc.id as string;
}

describe("findSuspiciousEconomicPurpose", () => {
  it("flags a legacy Purchase whose payee now resolves to an owned CREDIT_CARD account", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("legacy");
    const monzo = await newAccount(userId, { bankName: "Monzo" });
    const zable = await newAccount(userId, { bankName: "Zable", nickname: "Zable Credit Card", accountType: "CREDIT_CARD" });
    const txn = await prisma.transaction.create({
      data: { userId, accountId: monzo, direction: "EXPENSE", status: "COMPLETED", amountMinor: 25443n, currency: "GBP", bookedAt: new Date(), description: "Zable Card", recipientName: "Zable Card", transactionType: "PURCHASE" },
    });
    const candidates = await findSuspiciousEconomicPurpose(userId);
    const hit = candidates.find((c: any) => c.transactionId === txn.id);
    expect(hit).toBeTruthy();
    expect(hit.suggestedTransactionType).toBe("CREDIT_CARD_REPAYMENT");
    expect(hit.suggestedAccountId).toBe(zable);
  });

  it("flags a legacy Income transaction whose sender now resolves to another owned account", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("legacyincome");
    const halifax = await newAccount(userId, { bankName: "Halifax" });
    await newAccount(userId, { bankName: "Monzo", nickname: "Monzo" });
    await prisma.bankAccount.updateMany({ where: { userId, bankName: "Monzo" }, data: { accountHolderName: "Sardar Saeed" } });
    const txn = await prisma.transaction.create({
      data: { userId, accountId: halifax, direction: "INCOME", status: "COMPLETED", amountMinor: 200n, currency: "GBP", bookedAt: new Date(), description: "Transfer", senderName: "Sardar Saeed", transactionType: "INCOME" },
    });
    const candidates = await findSuspiciousEconomicPurpose(userId);
    const hit = candidates.find((c: any) => c.transactionId === txn.id);
    expect(hit).toBeTruthy();
    expect(hit.suggestedTransactionType).toBe("INTERNAL_TRANSFER");
  });

  it("never flags an already-correctly-classified transaction", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("clean");
    const acc = await newAccount(userId, { bankName: "Monzo" });
    await prisma.transaction.create({
      data: { userId, accountId: acc, direction: "EXPENSE", status: "COMPLETED", amountMinor: 500n, currency: "GBP", bookedAt: new Date(), description: "Tesco", recipientName: "Tesco", transactionType: "PURCHASE" },
    });
    const candidates = await findSuspiciousEconomicPurpose(userId);
    expect(candidates.length).toBe(0);
  });

  it("cross-user isolation: never scans another user's transactions", async (ctx) => {
    if (!ready) return ctx.skip();
    const userA = await newUser("crossA");
    const userB = await newUser("crossB");
    const bAcc = await newAccount(userB, { bankName: "Monzo" });
    await newAccount(userB, { bankName: "Zable", nickname: "Zable Credit Card", accountType: "CREDIT_CARD" });
    await prisma.transaction.create({
      data: { userId: userB, accountId: bAcc, direction: "EXPENSE", status: "COMPLETED", amountMinor: 1000n, currency: "GBP", bookedAt: new Date(), description: "Zable Card", recipientName: "Zable Card", transactionType: "PURCHASE" },
    });
    const candidatesForA = await findSuspiciousEconomicPurpose(userA);
    expect(candidatesForA.length).toBe(0);
  });
});

describe("findRepaymentsMissingMandate / linkCreditCardRepaymentToMandate", () => {
  it("finds a completed repayment whose company already has a mandate it isn't linked to, and links it without changing transactionType", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("mandategap");
    const acc = await newAccount(userId, { bankName: "Monzo" });
    const mandate = await prisma.directDebitMandate.create({
      data: { userId, accountId: acc, companyName: "Zable Card", normalizedCompanyName: normaliseCompany("Zable Card"), kind: "DIRECT_DEBIT", status: "ACTIVE", firstSeenAt: new Date() },
    });
    const txn = await prisma.transaction.create({
      data: { userId, accountId: acc, direction: "EXPENSE", status: "COMPLETED", amountMinor: 25443n, currency: "GBP", bookedAt: new Date(), description: "Zable Card", merchantName: "Zable Card", transactionType: "CREDIT_CARD_REPAYMENT" },
    });
    const gaps = await findRepaymentsMissingMandate(userId);
    const hit = gaps.find((g: any) => g.transactionId === txn.id);
    expect(hit).toBeTruthy();
    expect(hit.mandateId).toBe(mandate.id);

    const linkedId = await linkCreditCardRepaymentToMandate(userId, { transactionId: txn.id, accountId: acc, merchantName: "Zable Card", amountMinor: 25443, bookedAt: new Date() });
    expect(linkedId).toBe(mandate.id);
    const updated = await prisma.transaction.findUnique({ where: { id: txn.id } });
    expect(updated.directDebitMandateId).toBe(mandate.id);
    expect(updated.transactionType).toBe("CREDIT_CARD_REPAYMENT"); // never overwritten to DIRECT_DEBIT
  });

  it("returns null and links nothing when no mandate exists for that company", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("nomandate");
    const acc = await newAccount(userId, { bankName: "Monzo" });
    const txn = await prisma.transaction.create({
      data: { userId, accountId: acc, direction: "EXPENSE", status: "COMPLETED", amountMinor: 999n, currency: "GBP", bookedAt: new Date(), description: "Unknown Card", merchantName: "Unknown Card", transactionType: "CREDIT_CARD_REPAYMENT" },
    });
    const linkedId = await linkCreditCardRepaymentToMandate(userId, { transactionId: txn.id, accountId: acc, merchantName: "Unknown Card", amountMinor: 999, bookedAt: new Date() });
    expect(linkedId).toBeNull();
  });
});
