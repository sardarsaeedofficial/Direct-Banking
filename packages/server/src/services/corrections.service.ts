import type { CorrectionAction, Prisma } from "@prisma/client";
import { prisma } from "../db.js";

// Lightweight, append-only audit of important user corrections (Phase 5). Records
// only the changed canonical fields — never provider secrets or raw payloads. Any
// BigInt values are stringified so the JSON snapshots are serialisable.

function safeJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value == null) return undefined;
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) as Prisma.InputJsonValue;
}

export async function recordCorrection(
  userId: string,
  input: { transactionId?: string | null; action: CorrectionAction; before?: unknown; after?: unknown },
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  await client.transactionCorrection.create({
    data: {
      userId,
      transactionId: input.transactionId ?? null,
      action: input.action,
      beforeJson: safeJson(input.before),
      afterJson: safeJson(input.after),
    },
  });
}

export async function listCorrections(userId: string, limit = 100) {
  return prisma.transactionCorrection.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 500),
  });
}
