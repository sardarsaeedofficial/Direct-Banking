import { prisma } from "../db.js";

// Common noise found in bank/card descriptors that should not affect matching.
const NOISE = [
  /\b(card|visa|mastercard|maestro|contactless|pos|atm)\b/gi,
  /\b(ltd|limited|plc|inc|llc|co)\b/gi,
  /\bref[:# ].*/gi,
  /\b\d{2}[:.]\d{2}\b/g, // times
  /\*+\d+/g, // masked card fragments
  /\d{2}\/\d{2}(\/\d{2,4})?/g, // dates
  /\s{2,}/g,
];

/** Reduce a raw description to a stable key used to link the same merchant. */
export function normaliseMerchant(raw: string): string {
  let s = raw.toLowerCase();
  for (const re of NOISE) s = s.replace(re, " ");
  s = s.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  // Keep the first few meaningful tokens — enough to identify the merchant.
  return s.split(" ").slice(0, 4).join(" ") || raw.toLowerCase().trim();
}

/** Nice display name derived from the raw descriptor. */
export function displayNameFrom(raw: string): string {
  const cleaned = raw.replace(/\s{2,}/g, " ").trim();
  return cleaned
    .split(" ")
    .slice(0, 5)
    .map((w) => (w.length > 2 ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

/**
 * Find or create the merchant for a raw descriptor. Re-uses the existing
 * merchant when the normalised key matches — the transaction is linked, the
 * previous merchant record is never overwritten.
 */
export async function linkMerchant(
  userId: string,
  rawName: string | undefined | null,
): Promise<string | null> {
  const raw = rawName?.trim();
  if (!raw) return null;
  const normalisedKey = normaliseMerchant(raw);
  if (!normalisedKey) return null;

  const existing = await prisma.merchant.findUnique({
    where: { userId_normalisedKey: { userId, normalisedKey } },
  });
  if (existing) return existing.id;

  const created = await prisma.merchant.create({
    data: { userId, normalisedKey, displayName: displayNameFrom(raw) },
  });
  return created.id;
}
