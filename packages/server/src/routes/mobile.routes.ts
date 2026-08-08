import { Router } from "express";
import { NotifStatus, Prisma } from "@prisma/client";
import {
  mobileLoginSchema,
  mobileRegisterSchema,
  mobileRefreshSchema,
  mobileLogoutSchema,
  notifImportCreateSchema,
  notifAutoImportSchema,
  notifImportPatchSchema,
  notifImportQuerySchema,
} from "@direct-banking/shared";
import { prisma } from "../db.js";
import { verifyPassword } from "../auth/password.js";
import { verifyTotp } from "../auth/twofa.js";
import { issueTokensForDevice, rotateRefreshToken, revokeDevice, revokeAllDevices } from "../auth/mobile-session.js";
import { requireMobileAuth } from "../auth/mobile-middleware.js";
import { validate, validated } from "../middleware/validate.js";
import { asyncHandler, HttpError } from "../middleware/error.js";
import { authLimiter } from "../middleware/rateLimit.js";
import { createTransaction, defaultTypeFor } from "../services/transactions.service.js";
import { detectAndPairInternalTransfer } from "../services/internal-transfer.service.js";
import {
  detectDirectDebit,
  effectiveExpectation,
  getUpcomingPayments,
  normaliseCompany,
  recomputeMandate,
} from "../services/direct-debit.service.js";
import { getDashboard } from "../services/dashboard.service.js";
import { registerUser } from "../services/users.service.js";
import { txnCorrectionSchema, ddUpdateSchema, ddMergeSchema } from "@direct-banking/shared";

export const mobileRouter = Router();

function publicUser(u: { id: string; email: string; displayName: string | null; baseCurrency: string; locale: string; twoFactorEnabled: boolean }) {
  return { id: u.id, email: u.email, displayName: u.displayName, baseCurrency: u.baseCurrency, locale: u.locale, twoFactorEnabled: u.twoFactorEnabled };
}

/** Map parse confidence to a review state (spec: >=0.90 draft, 0.60–0.89 review, <0.60 unrecognised). */
function reviewStateFor(confidence: number): "DRAFT" | "REVIEW_REQUIRED" | "UNRECOGNISED" {
  if (confidence >= 0.9) return "DRAFT";
  if (confidence >= 0.6) return "REVIEW_REQUIRED";
  return "UNRECOGNISED";
}

// ── Auth ────────────────────────────────────────────────────────────────────

mobileRouter.post(
  "/auth/register",
  authLimiter,
  validate(mobileRegisterSchema),
  asyncHandler(async (req, res) => {
    const { email, password, displayName, device } = validated<typeof mobileRegisterSchema>(res);
    const user = await registerUser({ email, password, displayName });
    const tokens = await issueTokensForDevice(user.id, device);
    res.status(201).json({
      user: publicUser(user),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
    });
  }),
);

mobileRouter.post(
  "/auth/login",
  authLimiter,
  validate(mobileLoginSchema),
  asyncHandler(async (req, res) => {
    const { email, password, totp, device } = validated<typeof mobileLoginSchema>(res);
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, "scrypt$16384$00$00");
    if (!user || !ok) throw new HttpError(401, "Invalid email or password");
    if (user.twoFactorEnabled) {
      if (!totp || !user.twoFactorSecret || !verifyTotp(user.twoFactorSecret, totp)) {
        throw new HttpError(401, "A valid authentication code is required", { twoFactorRequired: true });
      }
    }
    const tokens = await issueTokensForDevice(user.id, device);
    res.json({
      user: publicUser(user),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
    });
  }),
);

mobileRouter.post(
  "/auth/refresh",
  authLimiter,
  validate(mobileRefreshSchema),
  asyncHandler(async (req, res) => {
    const { refreshToken } = validated<typeof mobileRefreshSchema>(res);
    const result = await rotateRefreshToken(refreshToken);
    if (!result.ok) throw new HttpError(401, "Refresh token is no longer valid", { reason: result.reason });
    res.json({
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      expiresIn: result.tokens.expiresIn,
    });
  }),
);

mobileRouter.post(
  "/auth/logout",
  requireMobileAuth,
  validate(mobileLogoutSchema),
  asyncHandler(async (req, res) => {
    const { allDevices } = validated<typeof mobileLogoutSchema>(res);
    if (allDevices) await revokeAllDevices(req.mobileAuth!.userId);
    else await revokeDevice(req.mobileAuth!.deviceRowId);
    res.json({ ok: true });
  }),
);

// ── Profile & bootstrap ─────────────────────────────────────────────────────

mobileRouter.get(
  "/me",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.mobileAuth!.userId },
      select: { id: true, email: true, displayName: true, baseCurrency: true, locale: true, twoFactorEnabled: true },
    });
    if (!user) throw new HttpError(404, "User not found");
    res.json({ user: publicUser(user) });
  }),
);

mobileRouter.get(
  "/bootstrap",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const [user, accounts, categories, directDebits, dashboard] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, displayName: true, baseCurrency: true, locale: true, twoFactorEnabled: true } }),
      prisma.bankAccount.findMany({ where: { userId, isArchived: false }, orderBy: { createdAt: "asc" } }),
      prisma.category.findMany({ where: { userId }, orderBy: { name: "asc" } }),
      prisma.recurringPayment.findMany({ where: { userId, status: "ACTIVE" }, orderBy: { nextDueDate: "asc" } }),
      getDashboard(userId),
    ]);
    const pendingImports = await prisma.notificationImport.count({ where: { userId, status: NotifStatus.PENDING } });
    res.json({
      user: user ? publicUser(user) : null,
      accounts,
      categories,
      directDebits,
      dashboard: {
        incomeMinor: dashboard.incomeMinor,
        expenseMinor: dashboard.expenseMinor,
        safeToSpendMinor: dashboard.safeToSpendMinor,
        totalBalanceMinor: dashboard.totalBalanceMinor,
        remainingDirectDebitsMinor: dashboard.remainingDirectDebitsMinor,
        upcoming: dashboard.upcoming,
        // Phase 2 Direct Debit analytics.
        directDebitsThisMonthMinor: dashboard.directDebitsThisMonthMinor,
        directDebitsThisYearMinor: dashboard.directDebitsThisYearMinor,
        avgMonthlyDirectDebitMinor: dashboard.avgMonthlyDirectDebitMinor,
        upcoming7DaysMinor: dashboard.upcoming7DaysMinor,
        upcoming30DaysMinor: dashboard.upcoming30DaysMinor,
        upcomingPayments: dashboard.upcomingPayments,
      },
      pendingImports,
      serverTime: new Date().toISOString(),
    });
  }),
);

// ── Transactions (read-only list for the mobile dashboard) ──────────────────

mobileRouter.get(
  "/transactions",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const accountId = typeof req.query.accountId === "string" ? req.query.accountId : undefined;
    const items = await prisma.transaction.findMany({
      where: { userId, parentId: null, accountId },
      include: {
        account: { select: { nickname: true } },
        category: { select: { name: true } },
        merchant: { select: { displayName: true } },
      },
      orderBy: { bookedAt: "desc" },
      take: limit,
    });
    res.json({ items, count: items.length });
  }),
);

// Manual ledger correction: change classification/metadata for one transaction.
// This never alters amount/direction/status, so account balances (and the
// balanceApplied safety flag) are never touched — only the canonical
// classification changes, which the dashboard totals honour automatically.
mobileRouter.patch(
  "/transactions/:id",
  requireMobileAuth,
  validate(txnCorrectionSchema),
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const body = validated<typeof txnCorrectionSchema>(res);
    const txn = await prisma.transaction.findFirst({ where: { id: req.params.id, userId } });
    if (!txn) throw new HttpError(404, "Transaction not found");

    // A linked own-account (single-sided transfer) must belong to this user.
    if (body.counterpartyAccountId) {
      const acc = await prisma.bankAccount.findFirst({ where: { id: body.counterpartyAccountId, userId } });
      if (!acc) throw new HttpError(404, "Linked account not found");
    }

    const data: Prisma.TransactionUncheckedUpdateInput = {};
    if (body.categoryId !== undefined) data.categoryId = body.categoryId;
    if (body.subcategory !== undefined) data.subcategory = body.subcategory;
    if (body.senderName !== undefined) data.senderName = body.senderName;
    if (body.senderBankName !== undefined) data.senderBankName = body.senderBankName;
    if (body.recipientName !== undefined) data.recipientName = body.recipientName;
    if (body.recipientBankName !== undefined) data.recipientBankName = body.recipientBankName;
    if (body.notes !== undefined) data.notes = body.notes;
    if (body.paymentReason !== undefined) data.paymentReason = body.paymentReason;
    if (body.paymentReference !== undefined) data.paymentReference = body.paymentReference;
    if (body.transactionType !== undefined) data.transactionType = body.transactionType;

    // Link the user's own account on the other side of a single-sided transfer.
    if (body.counterpartyAccountId !== undefined) {
      if (txn.direction === "INCOME") data.senderAccountId = body.counterpartyAccountId;
      else data.recipientAccountId = body.counterpartyAccountId;
    }

    // Explicit internal-transfer control (user confirmation / undo).
    if (body.markInternalTransfer === true) {
      data.transactionType = "INTERNAL_TRANSFER";
      data.internalTransferConfidence = "CONFIRMED";
      if (!txn.internalTransferGroupId) data.internalTransferGroupId = `manual-${txn.id}`;
    } else if (body.markInternalTransfer === false) {
      // Restore normal income/spending classification and unpair both sides.
      if (txn.internalTransferGroupId) {
        await prisma.transaction.updateMany({
          where: { userId, internalTransferGroupId: txn.internalTransferGroupId, id: { not: txn.id } },
          data: { transactionType: null, internalTransferGroupId: null, internalTransferConfidence: "NOT_INTERNAL" },
        });
      }
      data.transactionType = body.transactionType ?? defaultTypeFor(txn.direction);
      data.internalTransferGroupId = null;
      data.internalTransferConfidence = "NOT_INTERNAL";
    }

    // Direct Debit corrections: mark/unmark, or (re)assign to a named company.
    const mandatesToRecompute = new Set<string>();
    if (body.markDirectDebit === false) {
      if (txn.directDebitMandateId) mandatesToRecompute.add(txn.directDebitMandateId);
      data.directDebitMandateId = null;
      data.recurringKind = null;
      data.ddAnomaly = null;
      if (data.transactionType === undefined || txn.transactionType === "DIRECT_DEBIT") {
        data.transactionType = body.transactionType ?? defaultTypeFor(txn.direction);
      }
    } else if (body.markDirectDebit === true || (body.directDebitCompany != null && body.directDebitCompany !== "")) {
      if (txn.direction !== "EXPENSE") throw new HttpError(400, "Only outgoing payments can be Direct Debits");
      const companyName = (body.directDebitCompany ?? txn.merchantName ?? txn.description).trim();
      const normalized = normaliseCompany(companyName);
      if (!normalized) throw new HttpError(400, "A company name is required to mark a Direct Debit");
      const mandate = await prisma.directDebitMandate.upsert({
        where: { userId_accountId_normalizedCompanyName: { userId, accountId: txn.accountId, normalizedCompanyName: normalized } },
        update: {},
        create: { userId, accountId: txn.accountId, companyName, normalizedCompanyName: normalized, kind: "DIRECT_DEBIT", status: "ACTIVE", firstSeenAt: txn.bookedAt },
      });
      if (txn.directDebitMandateId && txn.directDebitMandateId !== mandate.id) mandatesToRecompute.add(txn.directDebitMandateId);
      mandatesToRecompute.add(mandate.id);
      data.transactionType = "DIRECT_DEBIT";
      data.directDebitMandateId = mandate.id;
      data.recurringKind = "DIRECT_DEBIT";
    }

    const updated = await prisma.transaction.update({
      where: { id: txn.id },
      data,
      include: { merchant: true, category: true, account: true },
    });
    // Recompute any mandate whose payment set changed (balance-safe: no money moved).
    for (const mid of mandatesToRecompute) await recomputeMandate(userId, mid);
    res.json({ transaction: updated });
  }),
);

// ── Direct Debits (Phase 2) ─────────────────────────────────────────────────

/** Serialise a mandate with its effective (user-override-aware) expectation. */
function publicMandate(m: Record<string, unknown>) {
  const e = effectiveExpectation(m as never);
  return {
    ...m,
    firstSeenAt: (m.firstSeenAt as Date | null)?.toISOString?.() ?? m.firstSeenAt,
    lastPaidAt: (m.lastPaidAt as Date | null)?.toISOString?.() ?? null,
    nextExpectedAt: (m.nextExpectedAt as Date | null)?.toISOString?.() ?? null,
    expectedNextDate: (m.expectedNextDate as Date | null)?.toISOString?.() ?? null,
    userExpectedDate: (m.userExpectedDate as Date | null)?.toISOString?.() ?? null,
    createdAt: (m.createdAt as Date | null)?.toISOString?.() ?? m.createdAt,
    updatedAt: (m.updatedAt as Date | null)?.toISOString?.() ?? m.updatedAt,
    effectiveAmountMinor: e.point,
    effectiveMinMinor: e.min,
    effectiveMaxMinor: e.max,
  };
}

mobileRouter.get(
  "/direct-debits",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : undefined;
    const sort = typeof req.query.sort === "string" ? req.query.sort : "next";
    const items = await prisma.directDebitMandate.findMany({
      where: {
        userId,
        status: status as never,
        ...(search ? { companyName: { contains: search, mode: "insensitive" } } : {}),
      },
      include: { account: { select: { nickname: true, bankName: true } } },
    });
    const mapped = items.map(publicMandate);
    const sorters: Record<string, (a: any, b: any) => number> = {
      next: (a, b) => (a.nextExpectedAt ?? "9999").localeCompare(b.nextExpectedAt ?? "9999"),
      company: (a, b) => String(a.companyName).localeCompare(String(b.companyName)),
      amount: (a, b) => (b.effectiveAmountMinor ?? 0) - (a.effectiveAmountMinor ?? 0),
    };
    mapped.sort(sorters[sort] ?? sorters.next);
    res.json({ items: mapped });
  }),
);

mobileRouter.get(
  "/upcoming-payments",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    const result = await getUpcomingPayments(req.mobileAuth!.userId, days);
    res.json(result);
  }),
);

async function mandateOr404(userId: string, id: string) {
  const m = await prisma.directDebitMandate.findFirst({ where: { id, userId }, include: { account: { select: { nickname: true, bankName: true } } } });
  if (!m) throw new HttpError(404, "Direct Debit not found");
  return m;
}

mobileRouter.get(
  "/direct-debits/:id",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const m = await mandateOr404(userId, req.params.id);
    const payments = await prisma.transaction.findMany({
      where: { userId, directDebitMandateId: m.id, direction: "EXPENSE", status: { in: ["COMPLETED", "PENDING"] } },
      select: { amountMinor: true, bookedAt: true },
      orderBy: { bookedAt: "desc" },
    });
    const amounts = payments.map((p) => Number(p.amountMinor));
    const now = new Date();
    const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const sum = (from: Date) => payments.filter((p) => p.bookedAt >= from).reduce((s, p) => s + Number(p.amountMinor), 0);
    const stats = {
      paidThisMonthMinor: sum(monthStart),
      paidThisYearMinor: sum(yearStart),
      averageMinor: amounts.length ? Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length) : 0,
      medianMinor: amounts.length ? [...amounts].sort((a, b) => a - b)[Math.floor(amounts.length / 2)]! : 0,
      highestMinor: amounts.length ? Math.max(...amounts) : 0,
      lowestMinor: amounts.length ? Math.min(...amounts) : 0,
    };
    res.json({ mandate: publicMandate(m), stats });
  }),
);

mobileRouter.get(
  "/direct-debits/:id/history",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    await mandateOr404(userId, req.params.id);
    const payments = await prisma.transaction.findMany({
      where: { userId, directDebitMandateId: req.params.id },
      select: { id: true, amountMinor: true, currency: true, bookedAt: true, ddAnomaly: true, status: true, description: true },
      orderBy: { bookedAt: "desc" },
    });
    res.json({ items: payments.map((p) => ({ ...p, amountMinor: Number(p.amountMinor) })) });
  }),
);

mobileRouter.patch(
  "/direct-debits/:id",
  requireMobileAuth,
  validate(ddUpdateSchema),
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const body = validated<typeof ddUpdateSchema>(res);
    const existing = await prisma.directDebitMandate.findFirst({ where: { id: req.params.id, userId } });
    if (!existing) throw new HttpError(404, "Direct Debit not found");
    if (body.accountId) {
      const acc = await prisma.bankAccount.findFirst({ where: { id: body.accountId, userId } });
      if (!acc) throw new HttpError(404, "Account not found");
    }

    const data: Prisma.DirectDebitMandateUncheckedUpdateInput = {};
    if (body.companyName !== undefined) {
      data.companyName = body.companyName;
      data.normalizedCompanyName = normaliseCompany(body.companyName);
    }
    if (body.accountId !== undefined) data.accountId = body.accountId;
    if (body.status !== undefined) data.status = body.status;
    if (body.frequency !== undefined) data.frequency = body.frequency;
    if (body.expectationMode !== undefined) data.expectationMode = body.expectationMode;
    if (body.alertDaysBefore !== undefined) data.alertDaysBefore = body.alertDaysBefore;
    if (body.amountTolerancePercent !== undefined) data.amountTolerancePercent = body.amountTolerancePercent;
    if (body.expectedDayOfMonth !== undefined) data.expectedDayOfMonth = body.expectedDayOfMonth;
    if (body.notes !== undefined) data.notes = body.notes;
    if (body.learnFromHistory !== undefined) data.learnFromHistory = body.learnFromHistory;
    if (body.userExpectedDate !== undefined) {
      data.userExpectedDate = body.userExpectedDate ? new Date(body.userExpectedDate) : null;
      if (body.userExpectedDate) data.nextExpectedAt = new Date(body.userExpectedDate);
    }
    // User-configured amount/range takes precedence over learned predictions.
    if (body.userExpectedAmountMinor !== undefined) {
      data.userExpectedAmountMinor = body.userExpectedAmountMinor;
      data.userConfiguredExpectedAmount = body.userExpectedAmountMinor != null;
    }
    if (body.userExpectedMinMinor !== undefined) data.userExpectedMinMinor = body.userExpectedMinMinor;
    if (body.userExpectedMaxMinor !== undefined) data.userExpectedMaxMinor = body.userExpectedMaxMinor;

    await prisma.directDebitMandate.update({ where: { id: existing.id }, data });
    const refreshed = await mandateOr404(userId, existing.id);
    res.json({ mandate: publicMandate(refreshed) });
  }),
);

// Merge a duplicate company's payments into another mandate, then recompute.
mobileRouter.post(
  "/direct-debits/:id/merge",
  requireMobileAuth,
  validate(ddMergeSchema),
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const { intoMandateId } = validated<typeof ddMergeSchema>(res);
    if (intoMandateId === req.params.id) throw new HttpError(400, "Cannot merge a mandate into itself");
    const from = await prisma.directDebitMandate.findFirst({ where: { id: req.params.id, userId } });
    const into = await prisma.directDebitMandate.findFirst({ where: { id: intoMandateId, userId } });
    if (!from || !into) throw new HttpError(404, "Direct Debit not found");
    await prisma.$transaction(async (tx) => {
      await tx.transaction.updateMany({ where: { userId, directDebitMandateId: from.id }, data: { directDebitMandateId: into.id } });
      await tx.directDebitMandate.delete({ where: { id: from.id } });
      await recomputeMandate(userId, into.id, tx);
    });
    const refreshed = await mandateOr404(userId, into.id);
    res.json({ mandate: publicMandate(refreshed) });
  }),
);

// ── Notification imports ────────────────────────────────────────────────────

mobileRouter.post(
  "/notification-imports",
  requireMobileAuth,
  validate(notifImportCreateSchema),
  asyncHandler(async (req, res) => {
    const c = validated<typeof notifImportCreateSchema>(res);
    const userId = req.mobileAuth!.userId;

    // Idempotent: the device fingerprint is the unique sourceHash per user, so a
    // reposted/updated notification never creates a duplicate.
    const existing = await prisma.notificationImport.findUnique({
      where: { userId_sourceHash: { userId, sourceHash: c.fingerprint } },
    });
    if (existing) {
      res.status(200).json({ import: existing, duplicate: true });
      return;
    }

    const created = await prisma.notificationImport.create({
      data: {
        userId,
        deviceId: req.mobileAuth!.deviceRowId,
        sourcePackage: c.sourcePackage,
        title: c.title || (c.merchant ?? "Transaction"),
        message: c.redactedSourceText, // redacted only — never full notification text
        redactedText: c.redactedSourceText,
        receivedAt: new Date(c.occurredAt),
        parsedMerchant: c.merchant ?? null,
        parsedAmountMinor: BigInt(c.amountMinor),
        parsedAccount: c.accountHint ?? null,
        direction: c.direction,
        currency: c.currency,
        confidence: c.confidence,
        reviewState: reviewStateFor(c.confidence),
        sourceHash: c.fingerprint,
        status: NotifStatus.PENDING,
      },
    });
    res.status(201).json({ import: created, duplicate: false });
  }),
);

// Atomic auto-import: create the (already-approved) import AND its transaction in
// a single database transaction, with the balance updated exactly once. Idempotent
// by fingerprint — retries and repeated callbacks never create a second
// transaction or move the balance twice.
mobileRouter.post(
  "/notification-imports/auto",
  requireMobileAuth,
  validate(notifAutoImportSchema),
  asyncHandler(async (req, res) => {
    const c = validated<typeof notifAutoImportSchema>(res);
    const userId = req.mobileAuth!.userId;

    const account = await prisma.bankAccount.findFirst({ where: { id: c.accountId, userId } });
    if (!account) throw new HttpError(404, "Account not found");

    // Fast-path duplicate: return the existing result without any change.
    const existing = await prisma.notificationImport.findUnique({ where: { userId_sourceHash: { userId, sourceHash: c.fingerprint } } });
    if (existing) {
      const txn = existing.approvedTransactionId
        ? await prisma.transaction.findUnique({ where: { id: existing.approvedTransactionId }, include: { merchant: true, category: true, account: true } })
        : null;
      res.status(200).json({ import: existing, transaction: txn, duplicate: true, result: "DUPLICATE" });
      return;
    }

    try {
      const out = await prisma.$transaction(async (tx) => {
        const importRow = await tx.notificationImport.create({
          data: {
            userId,
            deviceId: req.mobileAuth!.deviceRowId,
            sourcePackage: c.sourcePackage,
            title: c.title || (c.merchant ?? "Transaction"),
            message: c.redactedSourceText,
            redactedText: c.redactedSourceText,
            receivedAt: new Date(c.occurredAt),
            parsedMerchant: c.merchant ?? null,
            parsedAmountMinor: BigInt(c.amountMinor),
            parsedAccount: c.accountHint ?? null,
            direction: c.direction,
            currency: c.currency,
            confidence: c.confidence,
            reviewState: reviewStateFor(c.confidence),
            sourceHash: c.fingerprint,
            status: NotifStatus.APPROVED,
          },
        });
        const txn = await createTransaction(
          userId,
          {
            accountId: c.accountId,
            direction: c.direction,
            status: "COMPLETED",
            source: "NOTIFICATION",
            amountMinor: c.amountMinor,
            currency: c.currency,
            bookedAt: new Date(c.occurredAt),
            description: c.merchant ?? c.title,
            merchantName: c.merchant ?? c.title,
            categoryId: c.categoryId ?? undefined,
            // Enrichment (all optional): populate counterparties/reference for the ledger.
            senderName: c.senderName ?? undefined,
            senderBankName: c.senderBankName ?? undefined,
            recipientName: c.recipientName ?? undefined,
            recipientBankName: c.recipientBankName ?? undefined,
            paymentReference: c.paymentReference ?? undefined,
            paymentReason: c.paymentReason ?? undefined,
            sourceBankPackage: c.sourcePackage,
          },
          tx,
        );
        // Pair with the opposite side (own-account transfer) atomically within the import.
        const transferConfidence = await detectAndPairInternalTransfer(userId, txn.id, tx);
        // Direct Debit detection — never on an internal transfer.
        if (transferConfidence !== "CONFIRMED" && transferConfidence !== "HIGH") {
          await detectDirectDebit(
            userId,
            txn.id,
            {
              merchant: c.merchant ?? c.title,
              text: c.redactedSourceText,
              amountMinor: c.amountMinor,
              accountId: c.accountId,
              bookedAt: new Date(c.occurredAt),
              direction: c.direction,
              reference: c.paymentReference,
            },
            tx,
          );
        }
        const finalTxn = await tx.transaction.findUnique({ where: { id: txn.id }, include: { merchant: true, category: true, account: true } });
        const updated = await tx.notificationImport.update({ where: { id: importRow.id }, data: { approvedTransactionId: txn.id } });
        return { import: updated, transaction: finalTxn };
      });
      res.status(201).json({ ...out, duplicate: false, result: "AUTO_IMPORTED" });
    } catch (err) {
      // Concurrent duplicate (unique userId+sourceHash) → return the existing result.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const dup = await prisma.notificationImport.findUnique({ where: { userId_sourceHash: { userId, sourceHash: c.fingerprint } } });
        const txn = dup?.approvedTransactionId
          ? await prisma.transaction.findUnique({ where: { id: dup.approvedTransactionId }, include: { merchant: true, category: true, account: true } })
          : null;
        res.status(200).json({ import: dup, transaction: txn, duplicate: true, result: "DUPLICATE" });
        return;
      }
      throw err;
    }
  }),
);

mobileRouter.get(
  "/notification-imports",
  requireMobileAuth,
  validate(notifImportQuerySchema, "query"),
  asyncHandler(async (req, res) => {
    const q = validated<typeof notifImportQuerySchema>(res, "query");
    const items = await prisma.notificationImport.findMany({
      where: { userId: req.mobileAuth!.userId, status: q.status, reviewState: q.reviewState },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ items });
  }),
);

mobileRouter.patch(
  "/notification-imports/:id",
  requireMobileAuth,
  validate(notifImportPatchSchema),
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const body = validated<typeof notifImportPatchSchema>(res);
    const item = await prisma.notificationImport.findFirst({ where: { id: req.params.id, userId } });
    if (!item) throw new HttpError(404, "Import not found");

    if (body.action === "reject") {
      if (item.status === NotifStatus.APPROVED) throw new HttpError(409, "Cannot reject an already-approved import");
      const updated = await prisma.notificationImport.update({ where: { id: item.id }, data: { status: NotifStatus.REJECTED } });
      res.json({ import: updated });
      return;
    }

    // Apply any edits to the stored candidate.
    const amountMinor = body.amountMinor ?? (item.parsedAmountMinor != null ? Number(item.parsedAmountMinor) : undefined);
    const direction = body.direction ?? item.direction ?? "EXPENSE";
    const merchant = body.merchant ?? item.parsedMerchant ?? undefined;
    const occurredAt = body.occurredAt ? new Date(body.occurredAt) : item.receivedAt;

    if (body.action === "edit") {
      const updated = await prisma.notificationImport.update({
        where: { id: item.id },
        data: {
          parsedAmountMinor: amountMinor != null ? BigInt(amountMinor) : item.parsedAmountMinor,
          direction,
          parsedMerchant: merchant ?? null,
          receivedAt: occurredAt,
          reviewState: "REVIEW_REQUIRED",
        },
      });
      res.json({ import: updated });
      return;
    }

    // action === "approve": create a real transaction via the shared service so
    // web and Android dashboards stay consistent. Never trust device-only data:
    // the account must be a real account owned by this user.
    if (!body.accountId) throw new HttpError(400, "An account is required to approve");
    const account = await prisma.bankAccount.findFirst({ where: { id: body.accountId, userId } });
    if (!account) throw new HttpError(404, "Account not found");
    if (amountMinor == null || amountMinor <= 0) throw new HttpError(400, "A positive amount is required");

    // Idempotent claim: only a PENDING import can be approved. The atomic status
    // flip guarantees a repeated approval never creates a second transaction or
    // double-counts the balance.
    const claim = await prisma.notificationImport.updateMany({
      where: { id: item.id, userId, status: NotifStatus.PENDING },
      data: { status: NotifStatus.APPROVED },
    });
    if (claim.count === 0) {
      const current = await prisma.notificationImport.findFirst({ where: { id: item.id, userId } });
      if (current?.status !== NotifStatus.APPROVED) throw new HttpError(409, "Import cannot be approved");
      const existingTxn = current.approvedTransactionId
        ? await prisma.transaction.findUnique({ where: { id: current.approvedTransactionId }, include: { merchant: true, category: true, account: true } })
        : null;
      res.status(200).json({ import: current, transaction: existingTxn, duplicate: true });
      return;
    }

    try {
      const txn = await createTransaction(userId, {
        accountId: body.accountId,
        direction,
        status: "COMPLETED",
        source: "NOTIFICATION",
        amountMinor,
        currency: item.currency,
        bookedAt: occurredAt,
        description: merchant ?? item.title,
        merchantName: merchant ?? item.parsedMerchant ?? item.title,
        categoryId: body.categoryId ?? undefined,
        notes: body.notes,
        sourceBankPackage: item.sourcePackage,
      });
      const transferConfidence = await detectAndPairInternalTransfer(userId, txn.id);
      if (transferConfidence !== "CONFIRMED" && transferConfidence !== "HIGH") {
        await detectDirectDebit(userId, txn.id, {
          merchant: merchant ?? item.parsedMerchant ?? item.title,
          text: item.redactedText ?? item.message,
          amountMinor,
          accountId: body.accountId,
          bookedAt: occurredAt,
          direction,
        });
      }
      const finalTxn = await prisma.transaction.findUnique({ where: { id: txn.id }, include: { merchant: true, category: true, account: true } });
      const updated = await prisma.notificationImport.update({
        where: { id: item.id },
        data: { approvedTransactionId: txn.id },
      });
      res.status(201).json({ import: updated, transaction: finalTxn });
    } catch (err) {
      // A transient failure must leave the import reviewable (undo the claim).
      await prisma.notificationImport.updateMany({
        where: { id: item.id, userId, approvedTransactionId: null },
        data: { status: NotifStatus.PENDING },
      });
      throw err;
    }
  }),
);

mobileRouter.delete(
  "/notification-imports/:id",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const item = await prisma.notificationImport.findFirst({ where: { id: req.params.id, userId: req.mobileAuth!.userId } });
    if (!item) throw new HttpError(404, "Import not found");
    await prisma.notificationImport.delete({ where: { id: item.id } });
    res.json({ deleted: true });
  }),
);
