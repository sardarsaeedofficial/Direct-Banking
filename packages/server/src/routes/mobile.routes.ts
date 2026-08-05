import { Router } from "express";
import { NotifStatus } from "@prisma/client";
import {
  mobileLoginSchema,
  mobileRefreshSchema,
  mobileLogoutSchema,
  notifImportCreateSchema,
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
import { createTransaction } from "../services/transactions.service.js";
import { getDashboard } from "../services/dashboard.service.js";

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
    if (item.status === NotifStatus.APPROVED) throw new HttpError(409, "Already approved");

    if (body.action === "reject") {
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
    });

    const updated = await prisma.notificationImport.update({
      where: { id: item.id },
      data: { status: NotifStatus.APPROVED, approvedTransactionId: txn.id },
    });
    res.status(201).json({ import: updated, transaction: txn });
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
