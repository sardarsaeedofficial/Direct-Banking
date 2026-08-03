import { createHash } from "node:crypto";
import { prisma } from "../db.js";

/**
 * Deterministic hash used to spot duplicates: same account, same day, same
 * signed amount, same normalised description.
 */
export function dedupeHash(input: {
  accountId: string;
  bookedAt: Date;
  amountMinor: bigint;
  direction: string;
  description: string;
}): string {
  const day = input.bookedAt.toISOString().slice(0, 10);
  const desc = input.description.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 60);
  return createHash("sha256")
    .update(`${input.accountId}|${day}|${input.direction}|${input.amountMinor}|${desc}`)
    .digest("hex");
}

/** True if a transaction with this dedupe hash already exists for the user. */
export async function isDuplicate(userId: string, hash: string): Promise<boolean> {
  const found = await prisma.transaction.findFirst({
    where: { userId, dedupeHash: hash },
    select: { id: true },
  });
  return found !== null;
}
