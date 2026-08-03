import type { NextFunction, Request, Response } from "express";
import { CSRF_COOKIE, SESSION_COOKIE, resolveSession } from "./session.js";

export interface AuthContext {
  userId: string;
  sessionId: string;
  csrfSecret: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/** Populate req.auth if a valid session cookie is present (does not reject). */
export async function attachSession(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  const session = await resolveSession(token);
  if (session) {
    req.auth = { userId: session.userId, sessionId: session.id, csrfSecret: session.csrfSecret };
  }
  next();
}

/** Reject the request unless a valid session is attached. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.auth) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}

/**
 * Double-submit CSRF check for state-changing requests: the client echoes the
 * CSRF cookie value in the X-CSRF-Token header; it must match the session secret.
 */
export function requireCsrf(req: Request, res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }
  const header = req.get("x-csrf-token");
  const cookie = req.cookies?.[CSRF_COOKIE];
  if (!req.auth || !header || header !== cookie || header !== req.auth.csrfSecret) {
    res.status(403).json({ error: "Invalid CSRF token" });
    return;
  }
  next();
}
