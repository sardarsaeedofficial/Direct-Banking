import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// AccountIdentityResolver unit/integration tests. Opt-in via
// MOBILE_TEST_DATABASE_URL (same pattern as every other DB-backed test file).

let ready = false;
let server: Server | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let resolveOwnedAccount: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let confirmCounterpartyAccount: any;

beforeAll(async () => {
  const dbUrl = process.env.MOBILE_TEST_DATABASE_URL;
  if (!dbUrl) return;
  process.env.DATABASE_URL = dbUrl;
  process.env.MOBILE_JWT_SECRET ||= "test-mobile-secret-0123456789abcdef";
  process.env.SESSION_SECRET ||= "test-session-secret-0123456789abcdef";
  try {
    prisma = (await import("../../db.js")).prisma;
    await prisma.$queryRaw`SELECT 1`;
    const mod = await import("./account-identity-resolver.js");
    resolveOwnedAccount = mod.resolveOwnedAccount;
    confirmCounterpartyAccount = mod.confirmCounterpartyAccount;
    server = (await import("../../app.js")).createApp().listen(0);
    await new Promise((r) => server!.once("listening", r));
    ready = true;
  } catch {
    ready = false;
  }
});

afterAll(async () => {
  if (server) server.close();
  if (ready && prisma) await prisma.user.deleteMany({ where: { email: { contains: "resolvertest+" } } });
});

async function newUser(tag: string) {
  const email = `resolvertest+${tag}${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`.toLowerCase();
  const user = await prisma.user.create({ data: { email, passwordHash: "x" } });
  return user.id as string;
}

async function newAccount(userId: string, over: Partial<{ bankName: string; nickname: string; accountType: string; lastFour: string; providerAccountId: string; accountHolderName: string }> = {}) {
  const acc = await prisma.bankAccount.create({
    data: {
      userId,
      bankName: over.bankName ?? "Test Bank",
      nickname: over.nickname ?? over.bankName ?? "Test Bank",
      accountType: (over.accountType as never) ?? "CURRENT",
      lastFour: over.lastFour ?? null,
      providerAccountId: over.providerAccountId ?? null,
      accountHolderName: over.accountHolderName ?? null,
      currency: "GBP",
      balanceMinor: 0n,
    },
  });
  return acc.id as string;
}

describe("AccountIdentityResolver", () => {
  it("Tier 1: an exact owned accountId resolves at HIGH confidence", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("t1");
    const accId = await newAccount(userId);
    const r = await resolveOwnedAccount({ userId, accountId: accId });
    expect(r.accountId).toBe(accId);
    expect(r.confidence).toBe("HIGH");
    expect(r.evidenceTier).toBe("EXACT_ACCOUNT_ID");
  });

  it("never resolves to another user's account even with the exact id", async (ctx) => {
    if (!ready) return ctx.skip();
    const userA = await newUser("crossA");
    const userB = await newUser("crossB");
    const bAcc = await newAccount(userB);
    const r = await resolveOwnedAccount({ userId: userA, accountId: bAcc });
    expect(r.accountId).toBeNull();
  });

  it("Tier 2: an exact providerAccountId resolves at HIGH confidence", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("t2");
    const accId = await newAccount(userId, { providerAccountId: "plaid-acc-xyz" });
    const r = await resolveOwnedAccount({ userId, providerAccountId: "plaid-acc-xyz" });
    expect(r.accountId).toBe(accId);
    expect(r.evidenceTier).toBe("EXACT_PROVIDER_ACCOUNT_ID");
  });

  it("Tier 3: card last-4 + institution resolves uniquely", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("t3");
    const accId = await newAccount(userId, { bankName: "Capital One", lastFour: "7813", accountType: "CREDIT_CARD" });
    await newAccount(userId, { bankName: "Monzo", lastFour: "1234" });
    const r = await resolveOwnedAccount({ userId, last4: "7813", institutionHint: "Capital One" });
    expect(r.accountId).toBe(accId);
    expect(r.evidenceTier).toBe("EXACT_LAST4_AND_INSTITUTION");
  });

  it("Tier 3: ambiguous when two owned accounts share the same last-4 and institution", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("t3amb");
    await newAccount(userId, { bankName: "Monzo", lastFour: "1234" });
    await newAccount(userId, { bankName: "Monzo", lastFour: "1234" });
    const r = await resolveOwnedAccount({ userId, last4: "1234", institutionHint: "Monzo" });
    expect(r.accountId).toBeNull();
    expect(r.ambiguous).toBe(true);
    expect(r.candidateAccountIds.length).toBe(2);
  });

  it("Tier 4: a user-confirmed counterparty mapping resolves at HIGH confidence", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("t4");
    const zable = await newAccount(userId, { bankName: "Zable", nickname: "Zable Credit Card", accountType: "CREDIT_CARD" });
    await confirmCounterpartyAccount(userId, "Zable Card", zable);
    const r = await resolveOwnedAccount({ userId, counterpartyText: "Zable Card" });
    expect(r.accountId).toBe(zable);
    expect(r.evidenceTier).toBe("USER_CONFIRMED_MAPPING");
  });

  it("Tier 4 takes priority over Tier 5 (unique-at-institution) when both would apply", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("t4pri");
    const acc = await newAccount(userId, { bankName: "Zable", accountType: "CREDIT_CARD" });
    await confirmCounterpartyAccount(userId, "Zable Card", acc);
    const r = await resolveOwnedAccount({ userId, counterpartyText: "Zable Card", institutionHint: "Zable" });
    expect(r.evidenceTier).toBe("USER_CONFIRMED_MAPPING");
  });

  it("Tier 5: exactly one owned account of the desired type at the institution resolves uniquely", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("t5");
    const cc = await newAccount(userId, { bankName: "Capital One", accountType: "CREDIT_CARD" });
    const r = await resolveOwnedAccount({ userId, institutionHint: "Capital One", desiredAccountType: "CREDIT_CARD" as never });
    expect(r.accountId).toBe(cc);
    expect(r.evidenceTier).toBe("UNIQUE_AT_INSTITUTION");
  });

  it("Tier 5: ambiguous when the user owns two accounts at the same institution", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("t5amb");
    await newAccount(userId, { bankName: "Halifax" });
    await newAccount(userId, { bankName: "Halifax" });
    const r = await resolveOwnedAccount({ userId, institutionHint: "Halifax" });
    expect(r.accountId).toBeNull();
    expect(r.ambiguous).toBe(true);
  });

  it("unique bank account resolution: single unmapped account at an institution with no last4 still resolves", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("uniq");
    const acc = await newAccount(userId, { bankName: "Monzo" });
    const r = await resolveOwnedAccount({ userId, institutionHint: "Monzo" });
    expect(r.accountId).toBe(acc);
    expect(r.confidence).toBe("HIGH");
  });

  it("weak evidence only (name similarity) resolves at LOW confidence, never HIGH", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("weak");
    await newAccount(userId, { bankName: "Halifax", accountHolderName: "Sardar Saeed" });
    const r = await resolveOwnedAccount({ userId, counterpartyText: "SARDAR SAEED" });
    expect(r.confidence).toBe("LOW");
    expect(r.evidenceTier).toBe("ACCOUNT_HOLDER_NAME_SIMILARITY");
  });

  it("no evidence at all resolves to nothing, never a guess", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("none");
    await newAccount(userId, { bankName: "Halifax" });
    const r = await resolveOwnedAccount({ userId, counterpartyText: "Totally Unrelated Ltd" });
    expect(r.accountId).toBeNull();
    expect(r.confidence).toBe("NONE");
  });

  it("re-confirming a counterparty mapping updates it rather than erroring", async (ctx) => {
    if (!ready) return ctx.skip();
    const userId = await newUser("reconfirm");
    const accA = await newAccount(userId, { bankName: "Zable A", accountType: "CREDIT_CARD" });
    const accB = await newAccount(userId, { bankName: "Zable B", accountType: "CREDIT_CARD" });
    await confirmCounterpartyAccount(userId, "Zable Card", accA);
    await confirmCounterpartyAccount(userId, "Zable Card", accB);
    const r = await resolveOwnedAccount({ userId, counterpartyText: "Zable Card" });
    expect(r.accountId).toBe(accB);
  });
});
