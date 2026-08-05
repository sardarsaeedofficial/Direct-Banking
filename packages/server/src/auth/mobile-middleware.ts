import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { verifyAccessToken } from "./jwt.js";

export interface MobileAuthContext {
  userId: string;
  deviceRowId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      mobileAuth?: MobileAuthContext;
    }
  }
}

/** Require a valid Bearer access token whose device has not been revoked. */
export async function requireMobileAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }
  const claims = verifyAccessToken(match[1]!, env.MOBILE_JWT_SECRET);
  if (!claims) {
    res.status(401).json({ error: "Invalid or expired access token" });
    return;
  }
  // Ensure the device still exists and is not revoked (cheap indexed lookup).
  const device = await prisma.mobileDevice.findUnique({ where: { id: claims.did }, select: { revokedAt: true, userId: true } });
  if (!device || device.revokedAt || device.userId !== claims.sub) {
    res.status(401).json({ error: "Device session revoked" });
    return;
  }
  req.mobileAuth = { userId: claims.sub, deviceRowId: claims.did };
  next();
}
