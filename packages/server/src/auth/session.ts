import type { Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../db.js";
import { env } from "../env.js";

export const SESSION_COOKIE = "db_session";
export const CSRF_COOKIE = "db_csrf";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Create a DB-backed session and set the HTTP-only session cookie. */
export async function createSession(
  res: Response,
  userId: string,
  meta: { ip?: string; userAgent?: string },
): Promise<{ csrfToken: string }> {
  const token = randomBytes(32).toString("base64url");
  const csrfSecret = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 86_400_000);

  await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      csrfSecret,
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 300),
      expiresAt,
    },
  });

  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
  // CSRF token is readable by JS (double-submit); the matching secret is server-side only.
  res.cookie(CSRF_COOKIE, csrfSecret, {
    httpOnly: false,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });

  return { csrfToken: csrfSecret };
}

/** Resolve the session (and user) for an incoming request token, or null. */
export async function resolveSession(token: string | undefined) {
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  // Best-effort last-seen touch (non-blocking).
  void prisma.session
    .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
    .catch(() => {});
  return session;
}

export async function destroySession(res: Response, token: string | undefined) {
  if (token) {
    await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } });
  }
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.clearCookie(CSRF_COOKIE, { path: "/" });
}
