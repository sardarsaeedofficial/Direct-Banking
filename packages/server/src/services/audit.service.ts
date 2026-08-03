import type { Request } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { logger } from "../logger.js";

/**
 * Append an audit-log entry. Metadata is stored as-is but should never contain
 * secrets; the logger redacts known-sensitive keys as a second line of defence.
 */
export async function audit(
  req: Request,
  action: string,
  opts: { entityType?: string; entityId?: string; metadata?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: req.auth?.userId ?? null,
        action,
        entityType: opts.entityType,
        entityId: opts.entityId,
        ip: req.ip,
        userAgent: req.get("user-agent")?.slice(0, 300),
        metadata: (opts.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (err) {
    // Auditing must never break the primary request.
    logger.warn("Failed to write audit log", { action, message: (err as Error).message });
  }
}
