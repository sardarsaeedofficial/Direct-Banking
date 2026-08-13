import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Phase 5 integration tests (statement import, reconciliation, review centre,
// manual transfer pairing, correction audit, CSV export). Opt-in: set
// MOBILE_TEST_DATABASE_URL to a reachable Postgres, else the suite skips.

let ready = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let svc: any;
const EMAIL_TAG = "p5test+";

beforeAll(async () => {
  const dbUrl = process.env.MOBILE_TEST_DATABASE_URL;
  if (!dbUrl) { ready = false; return; }
  process.env.DATABASE_URL = dbUrl;
  process.env.MOBILE_JWT_SECRET ||= "test-mobile-secret-0123456789abcdef";
  process.env.SESSION_SECRET ||= "test-session-secret-0123456789abcdef";
  try {
    const db = await import("../db.js");
    prisma = db.prisma;
    await prisma.$queryRaw`SELECT 1`;
    svc = {
      users: await import("./users.service.js"),
      txns: await import("./transactions.service.js"),
      stmt: await import("./statement-import.service.js"),
      review: await import("./review.service.js"),
      pairing: await import("./transfer-pairing.service.js"),
      exp: await import("./export.service.js"),
      corrections: await import("./corrections.service.js"),
    };
    ready = true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[phase5.test] setup failed, skipping:", e);
    ready = false;
  }
});

afterAll(async () => {
  if (ready && prisma) await prisma.user.deleteMany({ where: { email: { contains: EMAIL_TAG } } });
});

let seq = 0;
async function newUser() {
  return svc.users.registerUser({ email: `${EMAIL_TAG}${Date.now()}_${seq++}@example.com`, password: "password1234" });
}
async function account(userId: string, accountType = "CURRENT", balanceMinor = 0, currency = "GBP", extra: Record<string, unknown> = {}) {
  return prisma.bankAccount.create({ data: { userId, bankName: "Test Bank", nickname: `${accountType} acct`, accountType, balanceMinor: BigInt(balanceMinor), currency, ...extra } });
}
function buf(s: string) { return Buffer.from(s, "utf8"); }

const CSV = `Date,Description,Amount,Balance
10/08/2026,TESCO STORES 0182,-18.30,481.70
11/08/2026,ACME PAYROLL,2000.00,2481.70
12/08/2026,NETFLIX.COM,-9.99,2471.71`;

async function importFile(userId: string, accountId: string, filename: string, fileType: string, content: Buffer, opts: any = {}) {
  const imp = await svc.stmt.createStatementImport(userId, { accountId, filename, fileType, buffer: content });
  const result = await svc.stmt.importStatement(userId, imp.id, opts);
  return { imp, result };
}

describe("Phase 5 — statement parsing & import", () => {
  it("imports a CSV, categorises rows, and does not move a LEDGER balance", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id, "CURRENT", 500000);
    const { imp, result } = await importFile(u.id, a.id, "june.csv", "CSV", buf(CSV));
    expect(imp.transactionCount).toBe(3);
    expect(result.imported).toBe(3);

    const txns = await prisma.transaction.findMany({ where: { userId: u.id, source: "STATEMENT_IMPORT" }, include: { category: true } });
    expect(txns.length).toBe(3);
    // Historical import must not change an established balance.
    const acc = await prisma.bankAccount.findUnique({ where: { id: a.id } });
    expect(acc.balanceMinor).toBe(500000n);
    expect(txns.every((t: any) => t.balanceApplied === false)).toBe(true);
    // Categorisation ran (Tesco → Groceries).
    const tesco = txns.find((t: any) => t.description.includes("TESCO"));
    expect(tesco.category?.code).toBe("GROCERIES");
  });

  it("parses OFX and QIF", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id);
    const ofx = `<OFX><CURDEF>GBP
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260810<TRNAMT>-18.30<FITID>o1<NAME>TESCO</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260811<TRNAMT>2000.00<FITID>o2<NAME>SALARY</STMTTRN></OFX>`;
    const r1 = await importFile(u.id, a.id, "s.ofx", "OFX", buf(ofx));
    expect(r1.result.imported).toBe(2);

    const b = await account(u.id, "SAVINGS");
    const qif = `!Type:Bank\nD10/08/2026\nT-18.30\nPTESCO\n^\nD11/08/2026\nT2000.00\nPSALARY\n^`;
    const r2 = await importFile(u.id, b.id, "s.qif", "QIF", buf(qif));
    expect(r2.result.imported).toBe(2);
  });

  it("parses a text PDF and rejects a scanned/opaque PDF", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id);
    const pdf = `%PDF-1.4
1 0 obj<</Type/Page>>endobj
stream
BT (10/08/2026 TESCO STORES -18.30) Tj T* (11/08/2026 SALARY 2000.00) Tj T* (12/08/2026 NETFLIX -9.99) Tj ET
endstream
%%EOF`;
    const { result } = await importFile(u.id, a.id, "s.pdf", "PDF", buf(pdf));
    expect(result.imported).toBe(3);

    const b = await account(u.id, "SAVINGS");
    const scanned = await svc.stmt.createStatementImport(u.id, { accountId: b.id, filename: "scan.pdf", fileType: "PDF", buffer: buf("%PDF-1.4 scanned image only, no text operators") });
    expect(scanned.status).toBe("FAILED");
    expect(scanned.error).toMatch(/nsupported/);
  });
});

describe("Phase 5 — duplicate protection", () => {
  it("importing the same file twice creates no duplicate transactions", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id);
    const first = await importFile(u.id, a.id, "june.csv", "CSV", buf(CSV));
    expect(first.result.imported).toBe(3);
    // Same bytes → idempotent session, re-import commits nothing new.
    const imp2 = await svc.stmt.createStatementImport(u.id, { accountId: a.id, filename: "june.csv", fileType: "CSV", buffer: buf(CSV) });
    expect(imp2.id).toBe(first.imp.id);
    const again = await svc.stmt.importStatement(u.id, imp2.id, {});
    expect(again.imported).toBe(0);
    const count = await prisma.transaction.count({ where: { userId: u.id, source: "STATEMENT_IMPORT" } });
    expect(count).toBe(3);
  });

  it("an overlapping row from a second statement is a duplicate, not a new transaction", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id);
    await importFile(u.id, a.id, "aug1.csv", "CSV", buf(CSV));
    // A different file (different hash) that repeats the Tesco row and adds one new row.
    const overlap = `Date,Description,Amount,Balance
10/08/2026,TESCO STORES 0182,-18.30,100.00
13/08/2026,SHELL LONDON,-40.00,60.00`;
    const { result } = await importFile(u.id, a.id, "aug2.csv", "CSV", buf(overlap));
    expect(result.duplicates).toBe(1); // Tesco row already recorded
    expect(result.imported).toBe(1); // only Shell is new
    const tescoCount = await prisma.transaction.count({ where: { userId: u.id, description: { contains: "TESCO" } } });
    expect(tescoCount).toBe(1);
  });
});

describe("Phase 5 — reconciliation with other sources", () => {
  it("a notification + a statement row reconcile to ONE canonical transaction with two evidence", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id);
    // A fast notification transaction, with its own evidence row.
    const notif = await svc.txns.createTransaction(u.id, { accountId: a.id, direction: "EXPENSE", amountMinor: 1830, description: "Tesco", merchantName: "Tesco", bookedAt: new Date("2026-08-10T10:04:00Z"), source: "NOTIFICATION" });
    await prisma.transactionEvidence.create({ data: { transactionId: notif.id, sourceType: "NOTIFICATION", notificationFingerprint: "fp-tesco" } });

    const csv = `Date,Description,Amount\n10/08/2026,TESCO STORES 0182,-18.30`;
    const { result } = await importFile(u.id, a.id, "n.csv", "CSV", buf(csv));
    expect(result.matched).toBe(1);
    expect(result.imported).toBe(0);

    const count = await prisma.transaction.count({ where: { userId: u.id, amountMinor: 1830n } });
    expect(count).toBe(1); // not two
    const evidence = await prisma.transactionEvidence.count({ where: { transactionId: notif.id } });
    expect(evidence).toBe(2); // notification + statement
  });

  it("a Plaid/provider transaction + a statement row reconcile to one canonical transaction", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id, "CURRENT", 0, "GBP", { balanceAuthority: "PROVIDER" });
    const prov = await svc.txns.createTransaction(u.id, { accountId: a.id, direction: "EXPENSE", amountMinor: 4200, description: "TESCO STORES", merchantName: "Tesco", bookedAt: new Date("2026-08-10T09:00:00Z"), source: "OPEN_BANKING", applyBalance: false });
    await prisma.transactionEvidence.create({ data: { transactionId: prov.id, sourceType: "OPEN_BANKING", provider: "plaid", providerTransactionId: "ptx-1" } });

    const csv = `Date,Description,Amount\n10/08/2026,TESCO STORES,-42.00`;
    const { result } = await importFile(u.id, a.id, "p.csv", "CSV", buf(csv));
    expect(result.matched).toBe(1);
    const count = await prisma.transaction.count({ where: { userId: u.id, amountMinor: 4200n } });
    expect(count).toBe(1);
  });

  it("importing history to a PROVIDER-authoritative account never changes its balance", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id, "CURRENT", 250000, "GBP", { balanceAuthority: "PROVIDER" });
    await importFile(u.id, a.id, "hist.csv", "CSV", buf(CSV), { rebuildBalance: true });
    const acc = await prisma.bankAccount.findUnique({ where: { id: a.id } });
    expect(acc.balanceMinor).toBe(250000n); // provider balance is authoritative
  });
});

describe("Phase 5 — classification from statement", () => {
  it("pairs an internal transfer detected from an imported row", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id, "CURRENT");
    const b = await account(u.id, "SAVINGS");
    // CSV dates parse to UTC midnight; align the other side so the pair scores strongly.
    const when = new Date("2026-08-10T00:00:00Z");
    // The other side already exists on account B.
    await svc.txns.createTransaction(u.id, { accountId: b.id, direction: "INCOME", amountMinor: 10000, description: "From current", bookedAt: when });
    const csv = `Date,Description,Amount\n10/08/2026,Transfer to savings,-100.00`;
    await importFile(u.id, a.id, "t.csv", "CSV", buf(csv));
    const paired = await prisma.transaction.findMany({ where: { userId: u.id, transactionType: "INTERNAL_TRANSFER" } });
    expect(paired.length).toBe(2);
    expect(new Set(paired.map((p: any) => p.internalTransferGroupId)).size).toBe(1);
  });

  it("detects a Direct Debit from an imported row", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id);
    const csv = `Date,Description,Amount\n10/08/2026,BRITISH GAS DIRECT DEBIT,-80.00`;
    await importFile(u.id, a.id, "dd.csv", "CSV", buf(csv));
    const mandate = await prisma.directDebitMandate.findFirst({ where: { userId: u.id, normalizedCompanyName: { contains: "britishgas" } } });
    expect(mandate).toBeTruthy();
  });
});

describe("Phase 5 — review centre, pairing, audit", () => {
  it("merges a possible duplicate into one canonical transaction, and keep-separate blocks re-merge", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id);
    const canonical = await svc.txns.createTransaction(u.id, { accountId: a.id, direction: "EXPENSE", amountMinor: 1830, description: "Tesco", merchantName: "Tesco", bookedAt: new Date("2026-08-10T10:00:00Z") });
    const dup = await svc.txns.createTransaction(u.id, { accountId: a.id, direction: "EXPENSE", amountMinor: 1830, description: "TESCO STORES", merchantName: "Tesco", bookedAt: new Date("2026-08-10T11:00:00Z") });
    await prisma.transaction.update({ where: { id: dup.id }, data: { possibleDuplicateOfId: canonical.id } });

    const merged = await svc.review.mergeDuplicate(u.id, dup.id);
    expect(merged.canonicalId).toBe(canonical.id);
    expect(await prisma.transaction.findUnique({ where: { id: dup.id } })).toBeNull();

    // keep-separate on a fresh pair prevents it appearing again.
    const dup2 = await svc.txns.createTransaction(u.id, { accountId: a.id, direction: "EXPENSE", amountMinor: 1830, description: "TESCO STORES", merchantName: "Tesco", bookedAt: new Date("2026-08-10T12:00:00Z") });
    await prisma.transaction.update({ where: { id: dup2.id }, data: { possibleDuplicateOfId: canonical.id } });
    await svc.review.keepSeparate(u.id, dup2.id);
    const centre = await svc.review.getReviewCentre(u.id);
    const stillListed = [...centre.possibleDuplicates, ...centre.uncertainStatementMatches].some((p: any) => p.transaction.id === dup2.id);
    expect(stillListed).toBe(false);
  });

  it("manually pairs and unpairs a transfer without changing balances, and writes an audit", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id, "CURRENT");
    const b = await account(u.id, "SAVINGS");
    const out = await svc.txns.createTransaction(u.id, { accountId: a.id, direction: "EXPENSE", amountMinor: 10000, description: "Move out", bookedAt: new Date() });
    const inc = await svc.txns.createTransaction(u.id, { accountId: b.id, direction: "INCOME", amountMinor: 10000, description: "Move in", bookedAt: new Date() });
    const balA = (await prisma.bankAccount.findUnique({ where: { id: a.id } })).balanceMinor;
    const balB = (await prisma.bankAccount.findUnique({ where: { id: b.id } })).balanceMinor;

    const pair = await svc.pairing.pairInternalTransfer(u.id, out.id, inc.id);
    expect(pair.transactionIds.length).toBe(2);
    const bothPaired = await prisma.transaction.findMany({ where: { id: { in: [out.id, inc.id] } } });
    expect(bothPaired.every((t: any) => t.transactionType === "INTERNAL_TRANSFER" && t.internalTransferGroupId === pair.groupId)).toBe(true);
    // Balances unchanged by pairing.
    expect((await prisma.bankAccount.findUnique({ where: { id: a.id } })).balanceMinor).toBe(balA);
    expect((await prisma.bankAccount.findUnique({ where: { id: b.id } })).balanceMinor).toBe(balB);
    // Audit written.
    const audit = await prisma.transactionCorrection.findFirst({ where: { userId: u.id, action: "INTERNAL_TRANSFER_PAIR" } });
    expect(audit).toBeTruthy();

    await svc.pairing.unpairInternalTransfer(u.id, out.id);
    const afterUnpair = await prisma.transaction.findMany({ where: { id: { in: [out.id, inc.id] } } });
    expect(afterUnpair.every((t: any) => t.internalTransferGroupId === null && t.transactionType !== "INTERNAL_TRANSFER")).toBe(true);
    expect((await prisma.bankAccount.findUnique({ where: { id: a.id } })).balanceMinor).toBe(balA);
  });
});

describe("Phase 5 — ownership isolation & export safety", () => {
  it("enforces ownership across import, pairing and merge", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const v = await newUser();
    const a = await account(u.id);
    const imp = await svc.stmt.createStatementImport(u.id, { accountId: a.id, filename: "o.csv", fileType: "CSV", buffer: buf(CSV) });
    // Another user cannot reconcile or import someone else's session.
    await expect(svc.stmt.reconcileStatement(v.id, imp.id)).rejects.toThrow();
    await expect(svc.stmt.importStatement(v.id, imp.id, {})).rejects.toThrow();
    // Cannot pair another user's transactions.
    const t1 = await svc.txns.createTransaction(u.id, { accountId: a.id, direction: "EXPENSE", amountMinor: 100, description: "x", bookedAt: new Date() });
    await expect(svc.pairing.pairInternalTransfer(v.id, t1.id, t1.id)).rejects.toThrow();
    await expect(svc.review.mergeDuplicate(v.id, t1.id)).rejects.toThrow();
  });

  it("exports canonical CSV with formula-injection neutralised and no secrets", async (ctx) => {
    if (!ready) return ctx.skip();
    const u = await newUser();
    const a = await account(u.id);
    await svc.txns.createTransaction(u.id, { accountId: a.id, direction: "EXPENSE", amountMinor: 500, description: "=SUM(A1:A9)", merchantName: "=cmd|calc", bookedAt: new Date() });
    const csv = await svc.exp.exportTransactionsCsv(u.id, {});
    expect(csv).toContain("Date,Time,Account");
    // Formula-leading cells are neutralised with a leading apostrophe.
    expect(csv).toMatch(/'=SUM|"'=SUM/);
    expect(csv).toMatch(/'=cmd|"'=cmd/);
    // Never leaks secrets.
    expect(csv.toLowerCase()).not.toContain("token");
    expect(csv.toLowerCase()).not.toContain("password");
    expect(csv.toLowerCase()).not.toContain("plaid");
  });
});
