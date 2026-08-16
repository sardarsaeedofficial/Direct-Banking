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
import { teachMerchantCategory } from "../services/categorization.service.js";
import {
  monthlySummary, periodComparison, categoryBreakdown, topMerchants, netWorth,
} from "../services/insights.service.js";
import { budgetProgress, evaluateBudgetAlerts } from "../services/budgets.service.js";
import { merchantProfile } from "../services/merchant-intelligence.service.js";
import { cashFlowForecast, safeToSpend, upcomingPayments } from "../services/cashflow.service.js";
import { recurringPaymentsView, detectSubscriptions } from "../services/recurring.service.js";
import type { PeriodKind } from "../services/period.service.js";
import {
  txnCorrectionSchema, ddUpdateSchema, ddMergeSchema,
  budgetSchema, budgetUpdateSchema, categorySchema,
  categoryRuleSchema, categoryRuleUpdateSchema, recurringPaymentPatchSchema,
} from "@direct-banking/shared";
import {
  startConnection,
  handleCallback,
  completeConnectionWithPublicToken,
  handleProviderWebhook,
  reauthorize,
  revokeConnection,
  syncConnection,
} from "../services/open-banking/bank-feed.service.js";
import { getProvider, openBankingEnabled, returnUri } from "../services/open-banking/registry.js";
import {
  createStatementImport,
  reconcileStatement,
  importStatement,
  ImportOwnershipError,
} from "../services/statement-import.service.js";
import { resolveFileType } from "../services/statement/index.js";
import { getReviewCentre, mergeDuplicate, keepSeparate, ReviewError } from "../services/review.service.js";
import { pairInternalTransfer, unpairInternalTransfer, TransferPairError } from "../services/transfer-pairing.service.js";
import { exportTransactionsCsv } from "../services/export.service.js";
import type { TxnType } from "@prisma/client";

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
    // Aggregate Open Banking sync status for the Home screen (§21).
    const connections = await prisma.bankConnection.findMany({
      where: { userId },
      select: { status: true, lastSuccessfulSyncAt: true },
    });
    const needsAttention = connections.filter((c) => c.status === "REAUTH_REQUIRED" || c.status === "ERROR" || c.status === "EXPIRED").length;
    const lastBankSyncAt = connections
      .map((c) => c.lastSuccessfulSyncAt?.getTime() ?? 0)
      .reduce((m, t) => Math.max(m, t), 0);
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
      bankSync: {
        connectionCount: connections.length,
        needsAttention,
        lastBankSyncAt: lastBankSyncAt > 0 ? new Date(lastBankSyncAt).toISOString() : null,
      },
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
    // Teach: a user's explicit category correction updates the merchant's learned
    // default so future transactions from the same merchant inherit it. Historical
    // rows are never rewritten — only future categorisation changes.
    if (body.categoryId !== undefined && txn.merchantId) {
      await teachMerchantCategory(userId, txn.merchantId, body.categoryId ?? null);
    }
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

// ── Bank connections / Open Banking (Phase 3) ───────────────────────────────

function requireOpenBanking() {
  if (!openBankingEnabled() || !getProvider()) throw new HttpError(503, "Open Banking is not enabled");
}

function publicConnection(c: Record<string, any>) {
  return {
    id: c.id,
    provider: c.provider,
    status: c.status,
    institutionName: c.institutionName,
    consentGrantedAt: c.consentGrantedAt?.toISOString?.() ?? null,
    consentExpiresAt: c.consentExpiresAt?.toISOString?.() ?? null,
    lastSyncedAt: c.lastSyncedAt?.toISOString?.() ?? null,
    lastSuccessfulSyncAt: c.lastSuccessfulSyncAt?.toISOString?.() ?? null,
    lastErrorAt: c.lastErrorAt?.toISOString?.() ?? null,
    lastErrorCode: c.lastErrorCode ?? null,
    createdAt: c.createdAt?.toISOString?.() ?? null,
  };
}

mobileRouter.post(
  "/bank-connections/start",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    requireOpenBanking();
    const result = await startConnection(req.mobileAuth!.userId, req.mobileAuth!.deviceRowId, returnUri());
    res.status(201).json(result);
  }),
);

mobileRouter.get(
  "/bank-connections",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const items = await prisma.bankConnection.findMany({ where: { userId: req.mobileAuth!.userId }, orderBy: { createdAt: "desc" } });
    res.json({ items: items.map(publicConnection) });
  }),
);

// Provider authorization callback (browser redirect target). No mobile JWT — the
// one-time `state` bound to the connection is the CSRF protection.
mobileRouter.get(
  "/bank-connections/callback",
  asyncHandler(async (req, res) => {
    requireOpenBanking();
    // Data v3: the user returns to our HTTPS return URI carrying our one-time
    // application state (no authorization code). We validate the state and then
    // resolve the connection lifecycle with the provider.
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!state) throw new HttpError(400, "Missing callback state");
    const result = await handleCallback(state);
    if (!result) throw new HttpError(400, "Invalid or expired authorization state");
    // Minimal success page; a production app deep-links back into the client.
    res.status(200).type("html").send("<!doctype html><meta charset=utf-8><title>Bank connected</title><body>Bank connected. You can return to Direct Banking.</body>");
  }),
);

// Complete a link-token connection (Plaid): the client sends the public_token it
// received from Plaid Link; the server exchanges it and starts importing.
mobileRouter.post(
  "/bank-connections/:id/complete",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    requireOpenBanking();
    const userId = req.mobileAuth!.userId;
    const publicToken = typeof req.body?.publicToken === "string" ? req.body.publicToken : "";
    if (!publicToken) throw new HttpError(400, "A public token is required");
    await connectionOr404(userId, req.params.id);
    const result = await completeConnectionWithPublicToken(userId, req.params.id, publicToken);
    if (!result.ok) throw new HttpError(result.code === "NOT_FOUND" ? 404 : 400, "Could not complete the connection", { code: result.code });
    res.json({ ok: true });
  }),
);

// Provider webhook (Plaid). Not mobile-authenticated — authenticity comes from the
// signed Plaid-Verification JWT (when configured); the body is never trusted as
// transaction data, only as a trigger for an idempotent sync.
mobileRouter.post(
  "/bank-connections/webhook",
  asyncHandler(async (req, res) => {
    const provider = getProvider();
    const jwt = req.header("plaid-verification");
    if (provider && typeof (provider as { verifyWebhook?: unknown }).verifyWebhook === "function" && jwt) {
      const raw = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
      const ok = await (provider as unknown as { verifyWebhook: (b: string, j: string) => Promise<boolean> }).verifyWebhook(raw, jwt);
      if (!ok) throw new HttpError(403, "Invalid webhook signature");
    }
    const body = (req.body ?? {}) as { webhook_type?: string; webhook_code?: string; item_id?: string };
    if (body.item_id && body.webhook_code) await handleProviderWebhook(body.item_id, body.webhook_code);
    res.json({ ok: true });
  }),
);

async function connectionOr404(userId: string, id: string) {
  const c = await prisma.bankConnection.findFirst({ where: { id, userId } });
  if (!c) throw new HttpError(404, "Connection not found");
  return c;
}

mobileRouter.get(
  "/bank-connections/:id",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const conn = await connectionOr404(userId, req.params.id);
    const accounts = await prisma.bankAccount.findMany({
      where: { userId, bankConnectionId: conn.id },
      select: { id: true, nickname: true, bankName: true, currency: true, accountHolderName: true, sortCodeMasked: true, accountNumberMasked: true, ibanMasked: true, balanceMinor: true, balanceAuthority: true },
    });
    res.json({
      connection: publicConnection(conn),
      accounts: accounts.map((a) => ({ ...a, balanceMinor: Number(a.balanceMinor) })),
    });
  }),
);

mobileRouter.post(
  "/bank-connections/:id/sync",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    requireOpenBanking();
    const userId = req.mobileAuth!.userId;
    await connectionOr404(userId, req.params.id);
    try {
      const summary = await syncConnection(userId, req.params.id);
      res.json({ ok: true, summary });
    } catch (err) {
      // Sanitised: never surface provider internals; previous data is preserved.
      const code = err instanceof Error ? err.message : "SYNC_FAILED";
      throw new HttpError(502, code === "REAUTH_REQUIRED" ? "Reauthorization required" : "Sync failed", { code });
    }
  }),
);

mobileRouter.post(
  "/bank-connections/:id/reauthorize",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    requireOpenBanking();
    const userId = req.mobileAuth!.userId;
    await connectionOr404(userId, req.params.id);
    const result = await reauthorize(userId, req.params.id, req.mobileAuth!.deviceRowId, returnUri());
    if (!result) throw new HttpError(404, "Connection not found");
    res.json(result);
  }),
);

mobileRouter.delete(
  "/bank-connections/:id",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    await connectionOr404(userId, req.params.id);
    const ok = await revokeConnection(userId, req.params.id);
    res.json({ revoked: ok });
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

// ══════════════════════════════════════════════════════════════════════════
// Phase 4 — Financial insights, budgets, categories, recurring, activity
// Every route is ownership-scoped by req.mobileAuth.userId and returns only
// canonical/derived data (never raw provider payloads, tokens or full account
// numbers). Reporting periods are computed in the user's timezone.
// ══════════════════════════════════════════════════════════════════════════

async function getUserTz(userId: string): Promise<string> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  return u?.timezone ?? "Europe/London";
}

function parsePeriod(req: { query: Record<string, unknown> }): { kind: PeriodKind; customStart?: Date; customEnd?: Date } {
  const p = typeof req.query.period === "string" ? req.query.period : "month";
  if (p === "custom") {
    const s = new Date(String(req.query.start));
    const e = new Date(String(req.query.end));
    if (isNaN(s.getTime()) || isNaN(e.getTime())) throw new HttpError(400, "A custom period requires valid start and end dates");
    return { kind: "custom", customStart: s, customEnd: e };
  }
  if (p === "week" || p === "year" || p === "month") return { kind: p };
  return { kind: "month" };
}

// ── Insights ────────────────────────────────────────────────────────────────
mobileRouter.get(
  "/insights/overview",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const tz = await getUserTz(userId);
    const [summary, comparison, budgets, worth, safe, upcoming] = await Promise.all([
      monthlySummary(userId, tz),
      periodComparison(userId, tz, "month"),
      budgetProgress(userId, tz),
      netWorth(userId),
      safeToSpend(userId),
      upcomingPayments(userId, 30),
    ]);
    res.json({ summary, comparison, budgets, netWorth: worth, safeToSpend: safe, upcoming });
  }),
);

mobileRouter.get(
  "/insights/summary",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const tz = await getUserTz(userId);
    const basis = req.query.basis === "year" ? "year" : "month";
    const [summary, comparison] = await Promise.all([monthlySummary(userId, tz), periodComparison(userId, tz, basis)]);
    res.json({ summary, comparison });
  }),
);

mobileRouter.get(
  "/insights/categories",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const tz = await getUserTz(userId);
    const { kind, customStart, customEnd } = parsePeriod(req);
    res.json(await categoryBreakdown(userId, tz, kind, { customStart, customEnd }));
  }),
);

mobileRouter.get(
  "/insights/merchants",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const tz = await getUserTz(userId);
    const { kind, customStart, customEnd } = parsePeriod(req);
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    res.json(await topMerchants(userId, tz, kind, { customStart, customEnd, limit }));
  }),
);

mobileRouter.get(
  "/insights/cash-flow",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const tz = await getUserTz(userId);
    res.json(await cashFlowForecast(userId, tz));
  }),
);

mobileRouter.get(
  "/insights/net-worth",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    res.json(await netWorth(req.mobileAuth!.userId));
  }),
);

mobileRouter.get(
  "/insights/safe-to-spend",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const reserve = Math.max(0, Number(req.query.reserve) || 0);
    res.json(await safeToSpend(req.mobileAuth!.userId, reserve));
  }),
);

// ── Categories ───────────────────────────────────────────────────────────────
mobileRouter.get(
  "/categories",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const items = await prisma.category.findMany({
      where: { userId: req.mobileAuth!.userId },
      select: { id: true, name: true, code: true, colour: true, icon: true, parentId: true, isSystem: true },
      orderBy: [{ parentId: "asc" }, { name: "asc" }],
    });
    res.json({ items });
  }),
);

mobileRouter.post(
  "/categories",
  requireMobileAuth,
  validate(categorySchema),
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const body = validated<typeof categorySchema>(res);
    if (body.parentId) {
      const parent = await prisma.category.findFirst({ where: { id: body.parentId, userId } });
      if (!parent) throw new HttpError(404, "Parent category not found");
    }
    const created = await prisma.category.create({
      data: { userId, name: body.name, colour: body.colour, icon: body.icon, parentId: body.parentId ?? null, isSystem: false },
    });
    res.status(201).json({ category: created });
  }),
);

mobileRouter.patch(
  "/categories/:id",
  requireMobileAuth,
  validate(categorySchema.partial()),
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const existing = await prisma.category.findFirst({ where: { id: req.params.id, userId } });
    if (!existing) throw new HttpError(404, "Category not found");
    const body = validated<ReturnType<typeof categorySchema.partial>>(res);
    const updated = await prisma.category.update({
      where: { id: existing.id },
      data: { name: body.name, colour: body.colour, icon: body.icon },
    });
    res.json({ category: updated });
  }),
);

mobileRouter.delete(
  "/categories/:id",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const existing = await prisma.category.findFirst({ where: { id: req.params.id, userId } });
    if (!existing) throw new HttpError(404, "Category not found");
    if (existing.isSystem) throw new HttpError(400, "Default categories cannot be deleted");
    // Detach references before deleting (rules cascade automatically). Transactions and
    // budgets keep their history but lose the category link; children reparent to root;
    // a merchant's learned default category is cleared rather than left dangling.
    await prisma.transaction.updateMany({ where: { userId, categoryId: existing.id }, data: { categoryId: null } });
    await prisma.budget.updateMany({ where: { userId, categoryId: existing.id }, data: { categoryId: null } });
    await prisma.category.updateMany({ where: { userId, parentId: existing.id }, data: { parentId: null } });
    await prisma.merchant.updateMany({ where: { userId, defaultCategoryId: existing.id }, data: { defaultCategoryId: null } });
    await prisma.category.delete({ where: { id: existing.id } });
    res.json({ deleted: true });
  }),
);

// ── Category rules ────────────────────────────────────────────────────────────
mobileRouter.get(
  "/category-rules",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const items = await prisma.categoryRule.findMany({
      where: { userId: req.mobileAuth!.userId },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    });
    res.json({ items });
  }),
);

async function assertOwnsCategory(userId: string, categoryId: string): Promise<void> {
  const cat = await prisma.category.findFirst({ where: { id: categoryId, userId }, select: { id: true } });
  if (!cat) throw new HttpError(404, "Category not found");
}

mobileRouter.post(
  "/category-rules",
  requireMobileAuth,
  validate(categoryRuleSchema),
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const body = validated<typeof categoryRuleSchema>(res);
    await assertOwnsCategory(userId, body.categoryId);
    if (body.subcategoryId) await assertOwnsCategory(userId, body.subcategoryId);
    const created = await prisma.categoryRule.create({
      data: {
        userId, field: body.field, operator: body.operator, value: body.value,
        categoryId: body.categoryId, subcategoryId: body.subcategoryId ?? null,
        priority: body.priority ?? 100, enabled: body.enabled ?? true,
      },
    });
    res.status(201).json({ rule: created });
  }),
);

mobileRouter.patch(
  "/category-rules/:id",
  requireMobileAuth,
  validate(categoryRuleUpdateSchema),
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const existing = await prisma.categoryRule.findFirst({ where: { id: req.params.id, userId } });
    if (!existing) throw new HttpError(404, "Rule not found");
    const body = validated<typeof categoryRuleUpdateSchema>(res);
    if (body.categoryId) await assertOwnsCategory(userId, body.categoryId);
    if (body.subcategoryId) await assertOwnsCategory(userId, body.subcategoryId);
    const updated = await prisma.categoryRule.update({ where: { id: existing.id }, data: body });
    res.json({ rule: updated });
  }),
);

mobileRouter.delete(
  "/category-rules/:id",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const existing = await prisma.categoryRule.findFirst({ where: { id: req.params.id, userId } });
    if (!existing) throw new HttpError(404, "Rule not found");
    await prisma.categoryRule.delete({ where: { id: existing.id } });
    res.json({ deleted: true });
  }),
);

// ── Budgets ──────────────────────────────────────────────────────────────────
mobileRouter.get(
  "/budgets",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const tz = await getUserTz(userId);
    res.json({ items: await budgetProgress(userId, tz) });
  }),
);

mobileRouter.get(
  "/budgets/alerts",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const tz = await getUserTz(userId);
    res.json({ alerts: await evaluateBudgetAlerts(userId, tz) });
  }),
);

mobileRouter.post(
  "/budgets",
  requireMobileAuth,
  validate(budgetSchema),
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const body = validated<typeof budgetSchema>(res);
    if (body.categoryId) await assertOwnsCategory(userId, body.categoryId);
    const created = await prisma.budget.create({
      data: {
        userId, name: body.name, categoryId: body.categoryId ?? null, period: body.period,
        limitMinor: BigInt(body.limitMinor), currency: body.currency, startDate: new Date(body.startDate),
        endDate: body.endDate ? new Date(body.endDate) : null,
        rolloverEnabled: body.rolloverEnabled ?? false, enabled: body.enabled ?? true,
        alert50: body.alert50 ?? true, alert75: body.alert75 ?? true, alert90: body.alert90 ?? true, alert100: body.alert100 ?? true,
      },
    });
    res.status(201).json({ budget: { ...created, limitMinor: Number(created.limitMinor) } });
  }),
);

mobileRouter.patch(
  "/budgets/:id",
  requireMobileAuth,
  validate(budgetUpdateSchema),
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const existing = await prisma.budget.findFirst({ where: { id: req.params.id, userId } });
    if (!existing) throw new HttpError(404, "Budget not found");
    const body = validated<typeof budgetUpdateSchema>(res);
    if (body.categoryId) await assertOwnsCategory(userId, body.categoryId);
    const data: Prisma.BudgetUncheckedUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.categoryId !== undefined) data.categoryId = body.categoryId;
    if (body.period !== undefined) data.period = body.period;
    if (body.limitMinor !== undefined) data.limitMinor = BigInt(body.limitMinor);
    if (body.currency !== undefined) data.currency = body.currency;
    if (body.startDate !== undefined) data.startDate = new Date(body.startDate);
    if (body.endDate !== undefined) data.endDate = body.endDate ? new Date(body.endDate) : null;
    if (body.rolloverEnabled !== undefined) data.rolloverEnabled = body.rolloverEnabled;
    if (body.enabled !== undefined) data.enabled = body.enabled;
    if (body.alert50 !== undefined) data.alert50 = body.alert50;
    if (body.alert75 !== undefined) data.alert75 = body.alert75;
    if (body.alert90 !== undefined) data.alert90 = body.alert90;
    if (body.alert100 !== undefined) data.alert100 = body.alert100;
    const updated = await prisma.budget.update({ where: { id: existing.id }, data });
    res.json({ budget: { ...updated, limitMinor: Number(updated.limitMinor) } });
  }),
);

mobileRouter.delete(
  "/budgets/:id",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const existing = await prisma.budget.findFirst({ where: { id: req.params.id, userId } });
    if (!existing) throw new HttpError(404, "Budget not found");
    await prisma.budget.delete({ where: { id: existing.id } });
    res.json({ deleted: true });
  }),
);

// ── Recurring payments (DD + subscriptions + standing orders, combined) ───────
mobileRouter.get(
  "/recurring-payments",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    res.json(await recurringPaymentsView(req.mobileAuth!.userId));
  }),
);

mobileRouter.get(
  "/recurring-payments/suggestions",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    res.json({ items: await detectSubscriptions(req.mobileAuth!.userId) });
  }),
);

mobileRouter.get(
  "/recurring-payments/:id",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const m = await prisma.directDebitMandate.findFirst({
      where: { id: req.params.id, userId },
      include: { account: { select: { nickname: true, bankName: true } } },
    });
    if (!m) throw new HttpError(404, "Recurring payment not found");
    const recentPayments = await prisma.transaction.findMany({
      where: { userId, directDebitMandateId: m.id },
      select: { id: true, amountMinor: true, bookedAt: true, description: true },
      orderBy: { bookedAt: "desc" }, take: 12,
    });
    res.json({ recurring: publicMandate(m), payments: recentPayments.map((p) => ({ ...p, amountMinor: Number(p.amountMinor), bookedAt: p.bookedAt.toISOString() })) });
  }),
);

mobileRouter.patch(
  "/recurring-payments/:id",
  requireMobileAuth,
  validate(recurringPaymentPatchSchema),
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const existing = await prisma.directDebitMandate.findFirst({ where: { id: req.params.id, userId } });
    if (!existing) throw new HttpError(404, "Recurring payment not found");
    const body = validated<typeof recurringPaymentPatchSchema>(res);
    const data: Prisma.DirectDebitMandateUncheckedUpdateInput = {};
    if (body.status !== undefined) data.status = body.status;
    if (body.notes !== undefined) data.notes = body.notes;
    if (body.userExpectedAmountMinor !== undefined) {
      data.userExpectedAmountMinor = body.userExpectedAmountMinor;
      data.userConfiguredExpectedAmount = body.userExpectedAmountMinor != null;
    }
    if (body.userExpectedDate !== undefined) data.userExpectedDate = body.userExpectedDate ? new Date(body.userExpectedDate) : null;
    await prisma.directDebitMandate.update({ where: { id: existing.id }, data });
    await recomputeMandate(userId, existing.id);
    const refreshed = await prisma.directDebitMandate.findFirst({
      where: { id: existing.id, userId },
      include: { account: { select: { nickname: true, bankName: true } } },
    });
    res.json({ recurring: publicMandate(refreshed!) });
  }),
);

// ── Merchant profile ──────────────────────────────────────────────────────────
mobileRouter.get(
  "/merchants/:id",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const tz = await getUserTz(userId);
    const profile = await merchantProfile(userId, req.params.id, tz);
    if (!profile) throw new HttpError(404, "Merchant not found");
    res.json({ merchant: profile });
  }),
);

// ── Activity search (server-side filters + pagination) ────────────────────────
mobileRouter.get(
  "/activity",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const q = req.query;
    const str = (k: string) => (typeof q[k] === "string" && (q[k] as string).trim() ? (q[k] as string).trim() : undefined);
    const limit = Math.min(Number(q.limit) || 50, 200);
    const offset = Math.max(0, Number(q.offset) || 0);

    const where: Prisma.TransactionWhereInput = { userId, parentId: null };
    const text = str("q");
    if (text) {
      where.OR = [
        { description: { contains: text, mode: "insensitive" } },
        { merchantName: { contains: text, mode: "insensitive" } },
        { senderName: { contains: text, mode: "insensitive" } },
        { recipientName: { contains: text, mode: "insensitive" } },
        { paymentReference: { contains: text, mode: "insensitive" } },
      ];
    }
    if (str("merchantId")) where.merchantId = str("merchantId");
    if (str("categoryId")) where.categoryId = str("categoryId");
    if (str("accountId")) where.accountId = str("accountId");
    if (str("sender")) where.senderName = { contains: str("sender")!, mode: "insensitive" };
    if (str("recipient")) where.recipientName = { contains: str("recipient")!, mode: "insensitive" };
    if (str("direction")) where.direction = str("direction") as never;
    if (str("type")) where.transactionType = str("type") as never;
    if (str("source")) where.source = str("source") as never;
    const settled = str("settled");
    if (settled === "pending") where.status = "PENDING";
    else if (settled === "settled") where.status = "COMPLETED";
    else if (str("status")) where.status = str("status") as never;

    const amount: Prisma.BigIntFilter = {};
    if (q.minAmount != null && !isNaN(Number(q.minAmount))) amount.gte = BigInt(Math.round(Number(q.minAmount)));
    if (q.maxAmount != null && !isNaN(Number(q.maxAmount))) amount.lte = BigInt(Math.round(Number(q.maxAmount)));
    if (amount.gte !== undefined || amount.lte !== undefined) where.amountMinor = amount;

    const dateFilter: Prisma.DateTimeFilter = {};
    if (str("from")) { const d = new Date(str("from")!); if (!isNaN(d.getTime())) dateFilter.gte = d; }
    if (str("to")) { const d = new Date(str("to")!); if (!isNaN(d.getTime())) dateFilter.lte = d; }
    if (dateFilter.gte !== undefined || dateFilter.lte !== undefined) where.bookedAt = dateFilter;

    const [total, rows] = await Promise.all([
      prisma.transaction.count({ where }),
      prisma.transaction.findMany({
        where,
        include: {
          account: { select: { nickname: true } },
          category: { select: { name: true, colour: true } },
          merchant: { select: { displayName: true } },
        },
        orderBy: { bookedAt: "desc" },
        skip: offset,
        take: limit,
      }),
    ]);
    const items = rows.map((t) => ({ ...t, amountMinor: Number(t.amountMinor) }));
    const nextOffset = offset + rows.length < total ? offset + rows.length : null;
    res.json({ items, total, limit, offset, nextOffset });
  }),
);

// ============================================================================
// Phase 5 — statement import, review centre, transfer pairing, export
// ============================================================================

const STATEMENT_MAX_BYTES = Number(process.env.STATEMENT_MAX_BYTES ?? 5_000_000);

function serializeImport(imp: {
  id: string; accountId: string; filename: string; fileType: string; institution: string | null;
  status: string; transactionCount: number; importedCount: number; duplicateCount: number; reviewCount: number;
  periodStart: Date | null; periodEnd: Date | null; error: string | null; createdAt: Date; completedAt: Date | null;
}) {
  return {
    id: imp.id, accountId: imp.accountId, filename: imp.filename, fileType: imp.fileType, institution: imp.institution,
    status: imp.status, transactionCount: imp.transactionCount, importedCount: imp.importedCount,
    duplicateCount: imp.duplicateCount, reviewCount: imp.reviewCount,
    periodStart: imp.periodStart?.toISOString() ?? null, periodEnd: imp.periodEnd?.toISOString() ?? null,
    error: imp.error, createdAt: imp.createdAt.toISOString(), completedAt: imp.completedAt?.toISOString() ?? null,
  };
}

// Upload + parse a statement (raw file is parsed in memory, never persisted).
mobileRouter.post(
  "/statements",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const body = (req.body ?? {}) as { accountId?: string; filename?: string; fileType?: string; contentBase64?: string; institution?: string };
    if (!body.accountId || !body.filename || !body.contentBase64) {
      throw new HttpError(400, "accountId, filename and contentBase64 are required");
    }
    const filename = body.filename.replace(/[\\/]/g, "_").slice(0, 200); // never used as a path
    let buffer: Buffer;
    try {
      buffer = Buffer.from(body.contentBase64, "base64");
    } catch {
      throw new HttpError(400, "contentBase64 is not valid base64");
    }
    if (buffer.length === 0) throw new HttpError(400, "Empty file");
    if (buffer.length > STATEMENT_MAX_BYTES) throw new HttpError(413, "Statement file too large");
    const fileType = resolveFileType(body.fileType, filename);
    if (!fileType) throw new HttpError(400, "Unsupported file type — use CSV, OFX, QIF or a text PDF");

    try {
      const imp = await createStatementImport(userId, { accountId: body.accountId, filename, fileType, buffer, institution: body.institution ?? null });
      res.status(201).json({ import: serializeImport(imp!) });
    } catch (e) {
      if (e instanceof ImportOwnershipError) throw new HttpError(404, e.message);
      throw e;
    }
  }),
);

mobileRouter.get(
  "/statements",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const rows = await prisma.statementImport.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 100 });
    res.json({ items: rows.map(serializeImport) });
  }),
);

async function ownedImport(userId: string, id: string) {
  const imp = await prisma.statementImport.findFirst({ where: { id, userId } });
  if (!imp) throw new HttpError(404, "Statement import not found");
  return imp;
}

mobileRouter.get(
  "/statements/:id",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const imp = await ownedImport(userId, req.params.id);
    res.json({ import: serializeImport(imp) });
  }),
);

mobileRouter.post(
  "/statements/:id/parse",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    await ownedImport(userId, req.params.id);
    const counts = await reconcileStatement(userId, req.params.id);
    const imp = await ownedImport(userId, req.params.id);
    res.json({ import: serializeImport(imp), counts });
  }),
);

mobileRouter.get(
  "/statements/:id/preview",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const imp = await ownedImport(userId, req.params.id);
    const candidates = await prisma.statementCandidate.findMany({ where: { statementImportId: imp.id }, orderBy: { rowIndex: "asc" }, take: 5000 });
    const rows = candidates.map((c) => ({
      id: c.id,
      rowIndex: c.rowIndex,
      bookedAt: c.bookedAt.toISOString(),
      amountMinor: Number(c.amountMinor),
      currency: c.currency,
      direction: c.direction,
      description: c.description,
      reference: c.reference,
      reconStatus: c.reconStatus,
      excluded: c.excluded,
    }));
    const summary = {
      found: candidates.length,
      newCount: rows.filter((r) => r.reconStatus === "NEW").length,
      duplicateCount: rows.filter((r) => r.reconStatus === "DUPLICATE" || r.reconStatus === "MATCHED").length,
      reviewCount: rows.filter((r) => r.reconStatus === "REVIEW").length,
    };
    res.json({ import: serializeImport(imp), summary, rows });
  }),
);

mobileRouter.post(
  "/statements/:id/import",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    await ownedImport(userId, req.params.id);
    const body = (req.body ?? {}) as { excludeRowIndexes?: number[]; rebuildBalance?: boolean };
    const excludeRowIndexes = Array.isArray(body.excludeRowIndexes) ? body.excludeRowIndexes.filter((n) => Number.isInteger(n)) : [];
    try {
      const result = await importStatement(userId, req.params.id, { excludeRowIndexes, rebuildBalance: body.rebuildBalance === true });
      const imp = await ownedImport(userId, req.params.id);
      res.json({ import: serializeImport(imp), result });
    } catch (e) {
      if (e instanceof ImportOwnershipError) throw new HttpError(404, e.message);
      throw e;
    }
  }),
);

mobileRouter.delete(
  "/statements/:id",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    await ownedImport(userId, req.params.id);
    await prisma.statementImport.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  }),
);

// ---- Review Centre ----
mobileRouter.get(
  "/review",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    res.json(await getReviewCentre(userId));
  }),
);

mobileRouter.post(
  "/review/:id/merge",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    try {
      res.json(await mergeDuplicate(userId, req.params.id));
    } catch (e) {
      if (e instanceof ReviewError) throw new HttpError(400, e.message);
      throw e;
    }
  }),
);

mobileRouter.post(
  "/review/:id/keep-separate",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    try {
      res.json(await keepSeparate(userId, req.params.id));
    } catch (e) {
      if (e instanceof ReviewError) throw new HttpError(400, e.message);
      throw e;
    }
  }),
);

// ---- Manual internal-transfer pairing ----
mobileRouter.post(
  "/internal-transfers/pair",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const body = (req.body ?? {}) as { transactionAId?: string; transactionBId?: string };
    if (!body.transactionAId || !body.transactionBId) throw new HttpError(400, "transactionAId and transactionBId are required");
    try {
      res.json(await pairInternalTransfer(userId, body.transactionAId, body.transactionBId));
    } catch (e) {
      if (e instanceof TransferPairError) throw new HttpError(400, e.message);
      throw e;
    }
  }),
);

mobileRouter.post(
  "/internal-transfers/unpair",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const body = (req.body ?? {}) as { transactionId?: string };
    if (!body.transactionId) throw new HttpError(400, "transactionId is required");
    try {
      res.json(await unpairInternalTransfer(userId, body.transactionId));
    } catch (e) {
      if (e instanceof TransferPairError) throw new HttpError(400, e.message);
      throw e;
    }
  }),
);

// ---- CSV export (canonical financial data only) ----
mobileRouter.get(
  "/export/transactions",
  requireMobileAuth,
  asyncHandler(async (req, res) => {
    const userId = req.mobileAuth!.userId;
    const q = req.query as Record<string, string | undefined>;
    const from = q.from ? new Date(q.from) : undefined;
    const to = q.to ? new Date(q.to) : undefined;
    const csv = await exportTransactionsCsv(userId, {
      accountId: q.accountId,
      categoryId: q.categoryId,
      transactionType: q.type as TxnType | undefined,
      from: from && !isNaN(from.getTime()) ? from : undefined,
      to: to && !isNaN(to.getTime()) ? to : undefined,
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="transactions.csv"');
    res.send(csv);
  }),
);
