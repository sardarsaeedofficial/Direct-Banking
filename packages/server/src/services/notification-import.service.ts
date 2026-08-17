import { createHash } from "node:crypto";
import { prisma } from "../db.js";
import { toMinor } from "@direct-banking/shared";
import { createTransaction } from "./transactions.service.js";
import { detectAndPairInternalTransfer } from "./internal-transfer.service.js";
import { detectDirectDebit } from "./direct-debit.service.js";
import { HttpError } from "../middleware/error.js";

export interface RawNotification {
  sourcePackage: string;
  title: string;
  message: string;
  receivedAt?: string;
}

// Known banking apps -> friendly bank label to help account matching.
const KNOWN_BANKS: Record<string, string> = {
  "co.uk.monzo": "Monzo",
  "com.monzo.app": "Monzo",
  "com.starlingbank.android": "Starling",
  "com.revolut.revolut": "Revolut",
  "uk.co.hsbc": "HSBC",
  "com.barclays.android": "Barclays",
  "com.lloydsbank.android": "Lloyds",
};

interface Parsed {
  merchant?: string;
  amountMinor?: number;
  account?: string;
  confidence: number;
}

/** Heuristic parse of a payment notification. Low confidence stays for review. */
export function parseNotification(n: RawNotification): Parsed {
  const text = `${n.title} ${n.message}`;
  let confidence = 0;

  // Amount: first currency-looking token.
  let amountMinor: number | undefined;
  const amtMatch = /(?:£|gbp\s*)?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i.exec(text);
  if (amtMatch && /£|gbp|paid|spent|payment|charged|debited/i.test(text)) {
    try {
      amountMinor = Math.abs(toMinor(amtMatch[1]!));
      confidence += 0.4;
    } catch {
      /* ignore */
    }
  }

  // Merchant: text after "at" / "to", else the title.
  let merchant: string | undefined;
  const merchMatch = /(?:at|to|from)\s+([A-Za-z0-9&'. -]{2,40})/i.exec(n.message);
  if (merchMatch) {
    merchant = merchMatch[1]!.trim().replace(/[.,]$/, "");
    confidence += 0.3;
  } else if (n.title && n.title.length <= 40) {
    merchant = n.title.trim();
    confidence += 0.1;
  }

  // Account from known package.
  const account = KNOWN_BANKS[n.sourcePackage];
  if (account) confidence += 0.2;

  // Outgoing-looking language raises confidence a little.
  if (/spent|paid|payment|debited|purchase/i.test(text)) confidence += 0.1;

  return { merchant, amountMinor, account, confidence: Math.min(1, Number(confidence.toFixed(2))) };
}

/** Ingest a raw notification into the review queue (idempotent by sourceHash). */
export async function ingestNotification(userId: string, n: RawNotification) {
  const sourceHash = createHash("sha256").update(`${n.sourcePackage}|${n.title}|${n.message}`).digest("hex");
  const parsed = parseNotification(n);
  const receivedAt = n.receivedAt ? new Date(n.receivedAt) : new Date();

  return prisma.notificationImport.upsert({
    where: { userId_sourceHash: { userId, sourceHash } },
    create: {
      userId,
      sourcePackage: n.sourcePackage,
      title: n.title,
      message: n.message,
      receivedAt,
      parsedMerchant: parsed.merchant,
      parsedAmountMinor: parsed.amountMinor != null ? BigInt(parsed.amountMinor) : null,
      parsedAccount: parsed.account,
      confidence: parsed.confidence,
      sourceHash,
      status: "PENDING",
    },
    update: {}, // never overwrite an existing review item
  });
}

/**
 * Approve a queued notification into a real transaction. Low-confidence items
 * are never auto-trusted — approval always requires an explicit account.
 */
export async function approveNotification(
  userId: string,
  id: string,
  override: { accountId?: string; parsedMerchant?: string; parsedAmountMinor?: number; categoryId?: string | null },
) {
  const item = await prisma.notificationImport.findFirst({ where: { id, userId } });
  if (!item) throw new HttpError(404, "Notification not found");
  if (item.status === "APPROVED") throw new HttpError(409, "Already approved");

  const accountId = override.accountId;
  if (!accountId) throw new HttpError(400, "An account is required to approve an import");
  const account = await prisma.bankAccount.findFirst({ where: { id: accountId, userId } });
  if (!account) throw new HttpError(404, "Account not found");

  const amountMinor = override.parsedAmountMinor ?? (item.parsedAmountMinor != null ? Number(item.parsedAmountMinor) : undefined);
  if (amountMinor == null || amountMinor <= 0) throw new HttpError(400, "A positive amount is required");

  const txn = await createTransaction(userId, {
    accountId,
    direction: "EXPENSE",
    source: "NOTIFICATION",
    amountMinor,
    bookedAt: item.receivedAt,
    description: override.parsedMerchant ?? item.parsedMerchant ?? item.title,
    merchantName: override.parsedMerchant ?? item.parsedMerchant ?? item.title,
    categoryId: override.categoryId ?? undefined,
  });

  // Same classification pipeline the mobile approve flow runs (Phase 6 audit fix):
  // an internal transfer approved from the web UI must never be left counting as
  // real income/spending, and a genuine Direct Debit should still be recognised.
  const transferConfidence = await detectAndPairInternalTransfer(userId, txn.id);
  if (transferConfidence !== "CONFIRMED" && transferConfidence !== "HIGH") {
    await detectDirectDebit(userId, txn.id, {
      merchant: txn.merchantName ?? txn.description,
      text: txn.description,
      amountMinor: Number(txn.amountMinor),
      accountId: txn.accountId,
      bookedAt: txn.bookedAt,
      direction: txn.direction,
      reference: txn.paymentReference,
    });
  }

  await prisma.notificationImport.update({ where: { id }, data: { status: "APPROVED" } });
  return txn;
}

export async function rejectNotification(userId: string, id: string) {
  const item = await prisma.notificationImport.findFirst({ where: { id, userId } });
  if (!item) throw new HttpError(404, "Notification not found");
  return prisma.notificationImport.update({ where: { id }, data: { status: "REJECTED" } });
}
