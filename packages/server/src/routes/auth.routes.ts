import { Router } from "express";
import { loginSchema, registerSchema, changePasswordSchema } from "@direct-banking/shared";
import { prisma } from "../db.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { createSession, destroySession, SESSION_COOKIE } from "../auth/session.js";
import { requireAuth, requireCsrf } from "../auth/middleware.js";
import { generateTotpSecret, totpUri, verifyTotp } from "../auth/twofa.js";
import { validate, validated } from "../middleware/validate.js";
import { asyncHandler, HttpError } from "../middleware/error.js";
import { authLimiter } from "../middleware/rateLimit.js";
import { audit } from "../services/audit.service.js";

export const authRouter = Router();

const DEFAULT_CATEGORIES = [
  { name: "Housing", colour: "#6366f1" },
  { name: "Utilities", colour: "#0ea5e9" },
  { name: "Groceries", colour: "#22c55e" },
  { name: "Transport", colour: "#f59e0b" },
  { name: "Subscriptions", colour: "#a855f7" },
  { name: "Insurance", colour: "#14b8a6" },
  { name: "Eating out", colour: "#ef4444" },
  { name: "Income", colour: "#10b981" },
  { name: "Savings", colour: "#3b82f6" },
  { name: "Other", colour: "#64748b" },
];

authRouter.post(
  "/register",
  authLimiter,
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const { email, password, displayName } = validated<typeof registerSchema>(res);
    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) throw new HttpError(409, "An account with that email already exists");

    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        passwordHash: await hashPassword(password),
        displayName,
        categories: { create: DEFAULT_CATEGORIES },
      },
    });
    const { csrfToken } = await createSession(res, user.id, { ip: req.ip, userAgent: req.get("user-agent") ?? undefined });
    await audit(req, "auth.register", { entityType: "User", entityId: user.id });
    res.status(201).json({ user: { id: user.id, email: user.email, displayName: user.displayName }, csrfToken });
  }),
);

authRouter.post(
  "/login",
  authLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password, totp } = validated<typeof loginSchema>(res);
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    // Constant-ish work whether or not the user exists.
    const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, "scrypt$16384$00$00");
    if (!user || !ok) {
      await audit(req, "auth.login.failed", { metadata: { email } });
      throw new HttpError(401, "Invalid email or password");
    }
    if (user.twoFactorEnabled) {
      if (!totp || !user.twoFactorSecret || !verifyTotp(user.twoFactorSecret, totp)) {
        throw new HttpError(401, "A valid authentication code is required", { twoFactorRequired: true });
      }
    }
    const { csrfToken } = await createSession(res, user.id, { ip: req.ip, userAgent: req.get("user-agent") ?? undefined });
    await audit(req, "auth.login", { entityType: "User", entityId: user.id });
    res.json({ user: { id: user.id, email: user.email, displayName: user.displayName }, csrfToken });
  }),
);

authRouter.post(
  "/logout",
  requireAuth,
  requireCsrf,
  asyncHandler(async (req, res) => {
    await destroySession(res, req.cookies?.[SESSION_COOKIE]);
    await audit(req, "auth.logout");
    res.json({ ok: true });
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: { id: true, email: true, displayName: true, baseCurrency: true, locale: true, twoFactorEnabled: true },
    });
    res.json({ user });
  }),
);

authRouter.post(
  "/change-password",
  requireAuth,
  requireCsrf,
  validate(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = validated<typeof changePasswordSchema>(res);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
    if (!(await verifyPassword(currentPassword, user.passwordHash))) throw new HttpError(400, "Current password is incorrect");
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(newPassword) } });
    // Invalidate other sessions for safety.
    await prisma.session.deleteMany({ where: { userId: user.id, id: { not: req.auth!.sessionId } } });
    await audit(req, "auth.change_password", { entityType: "User", entityId: user.id });
    res.json({ ok: true });
  }),
);

// ---- Two-factor authentication (optional) ----
authRouter.post(
  "/2fa/setup",
  requireAuth,
  requireCsrf,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
    const secret = generateTotpSecret();
    await prisma.user.update({ where: { id: user.id }, data: { twoFactorSecret: secret, twoFactorEnabled: false } });
    res.json({ secret, otpauthUri: totpUri(secret, user.email) });
  }),
);

authRouter.post(
  "/2fa/enable",
  requireAuth,
  requireCsrf,
  validate(loginSchema.pick({ totp: true })),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
    const totp = (res.locals.body as { totp?: string }).totp;
    if (!user.twoFactorSecret || !totp || !verifyTotp(user.twoFactorSecret, totp)) throw new HttpError(400, "Invalid code");
    await prisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: true } });
    await audit(req, "auth.2fa.enable", { entityType: "User", entityId: user.id });
    res.json({ ok: true });
  }),
);

authRouter.post(
  "/2fa/disable",
  requireAuth,
  requireCsrf,
  asyncHandler(async (req, res) => {
    await prisma.user.update({ where: { id: req.auth!.userId }, data: { twoFactorEnabled: false, twoFactorSecret: null } });
    await audit(req, "auth.2fa.disable", { entityType: "User", entityId: req.auth!.userId });
    res.json({ ok: true });
  }),
);
