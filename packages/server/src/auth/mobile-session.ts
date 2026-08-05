import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { signAccessToken } from "./jwt.js";

// Mobile session lifecycle: opaque rotating refresh tokens (stored hashed) +
// short-lived JWT access tokens. Refresh-token reuse revokes the whole device.

function sha256(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

export interface DeviceInfo {
  deviceId: string;
  model?: string;
  appVersion?: string;
  platform?: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // access token TTL seconds
  deviceRowId: string;
}

/** Register/refresh the device row and mint a fresh access+refresh pair. */
export async function issueTokensForDevice(userId: string, info: DeviceInfo): Promise<IssuedTokens> {
  const device = await prisma.mobileDevice.upsert({
    where: { userId_deviceId: { userId, deviceId: info.deviceId } },
    create: {
      userId,
      deviceId: info.deviceId,
      platform: info.platform ?? "android",
      model: info.model,
      appVersion: info.appVersion,
    },
    update: { lastSeenAt: new Date(), revokedAt: null, model: info.model, appVersion: info.appVersion },
  });
  return mintPair(userId, device.id);
}

async function mintPair(userId: string, deviceRowId: string): Promise<IssuedTokens> {
  const ttlSeconds = env.MOBILE_ACCESS_TTL_MIN * 60;
  const accessToken = signAccessToken({ sub: userId, did: deviceRowId }, env.MOBILE_JWT_SECRET, ttlSeconds);
  const refreshToken = randomBytes(48).toString("base64url");
  await prisma.mobileRefreshToken.create({
    data: {
      userId,
      deviceId: deviceRowId,
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + env.MOBILE_REFRESH_TTL_DAYS * 86_400_000),
    },
  });
  return { accessToken, refreshToken, expiresIn: ttlSeconds, deviceRowId };
}

export type RefreshResult =
  | { ok: true; tokens: IssuedTokens }
  | { ok: false; reason: "invalid" | "expired" | "revoked" | "reuse" };

/**
 * Rotate a refresh token. On success the old token is revoked and a new pair is
 * minted. Presenting an already-rotated/revoked token is treated as theft and
 * revokes every token for that device.
 */
export async function rotateRefreshToken(refreshToken: string): Promise<RefreshResult> {
  const tokenHash = sha256(refreshToken);
  const existing = await prisma.mobileRefreshToken.findUnique({
    where: { tokenHash },
    include: { device: true },
  });
  if (!existing) return { ok: false, reason: "invalid" };

  if (existing.revokedAt || existing.rotatedAt) {
    // Reuse of a consumed token → revoke the whole device's tokens.
    await prisma.mobileRefreshToken.updateMany({
      where: { deviceId: existing.deviceId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await prisma.mobileDevice.update({ where: { id: existing.deviceId }, data: { revokedAt: new Date() } }).catch(() => {});
    return { ok: false, reason: "reuse" };
  }
  if (existing.device.revokedAt) return { ok: false, reason: "revoked" };
  if (existing.expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" };

  const tokens = await mintPair(existing.userId, existing.deviceId);
  const successor = await prisma.mobileRefreshToken.findUnique({ where: { tokenHash: sha256(tokens.refreshToken) } });
  await prisma.mobileRefreshToken.update({
    where: { id: existing.id },
    data: { rotatedAt: new Date(), revokedAt: new Date(), replacedById: successor?.id },
  });
  await prisma.mobileDevice.update({ where: { id: existing.deviceId }, data: { lastSeenAt: new Date() } }).catch(() => {});
  return { ok: true, tokens };
}

/** Revoke the current device's tokens (logout). */
export async function revokeDevice(deviceRowId: string): Promise<void> {
  await prisma.mobileRefreshToken.updateMany({ where: { deviceId: deviceRowId, revokedAt: null }, data: { revokedAt: new Date() } });
  await prisma.mobileDevice.update({ where: { id: deviceRowId }, data: { revokedAt: new Date() } }).catch(() => {});
}

/** Revoke every device/token for the user (logout all devices). */
export async function revokeAllDevices(userId: string): Promise<void> {
  await prisma.mobileRefreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  await prisma.mobileDevice.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}
