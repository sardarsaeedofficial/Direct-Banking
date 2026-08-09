import type { Prisma } from "@prisma/client";
import { createTransaction } from "../transactions.service.js";
import { detectAndPairInternalTransfer } from "../internal-transfer.service.js";
import { detectDirectDebit } from "../direct-debit.service.js";
import { normaliseMerchant } from "../merchant-normalise.service.js";
import type { ProviderTransaction } from "./provider.js";

// TransactionReconciliationService (Phase 3).
//
// One canonical transaction may be observed via several sources (a fast
// notification and the authoritative Open Banking feed). Reconciliation makes a
// notification + provider record for the SAME payment converge to one row, while
// never merging genuinely unrelated transactions.

export type ReconResult = "EXACT_MATCH" | "HIGH_CONFIDENCE_MATCH" | "POSSIBLE_MATCH" | "NEW_TRANSACTION" | "DUPLICATE";

export interface ReconOutcome {
  result: ReconResult;
  transactionId: string;
}

export interface ReconAccount {
  id: string;
  currency: string;
  balanceAuthority: "LEDGER" | "PROVIDER";
}

const MIN = 60_000;
const MATCH_WINDOW_MS = 4 * 24 * 60 * MIN;

function firstWord(s: string): string {
  return s.split(/\s+/)[0] ?? "";
}

/** Loose merchant similarity — descriptions need not be identical. */
function merchantSimilar(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normaliseMerchant(a ?? "");
  const nb = normaliseMerchant(b ?? "");
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.startsWith(nb) || nb.startsWith(na)) return true;
  return firstWord(na).length >= 3 && firstWord(na) === firstWord(nb);
}

function referenceSimilar(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

interface Candidate {
  id: string;
  bookedAt: Date;
  merchantName: string | null;
  description: string;
  paymentReference: string | null;
  status: string;
}

/** Score a candidate notification transaction against a provider transaction. */
function score(cand: Candidate, ptxn: ProviderTransaction): { result: ReconResult; points: number } {
  const booked = new Date(ptxn.bookedAt).getTime();
  const dtMin = Math.abs(cand.bookedAt.getTime() - booked) / MIN;
  let pts = 0.4; // amount + direction + account + currency already gated by the query
  if (dtMin <= 10) pts += 0.45;
  else if (dtMin <= 120) pts += 0.35;
  else if (dtMin <= 1440) pts += 0.2;
  else pts += 0.05;

  const merch = merchantSimilar(cand.merchantName ?? cand.description, ptxn.merchantName ?? ptxn.description) ? 0.25 : 0;
  const ref = referenceSimilar(cand.paymentReference, ptxn.reference) ? 0.2 : 0;
  pts += Math.max(merch, ref);
  pts = Math.min(pts, 1);

  const result: ReconResult = pts >= 0.85 ? "HIGH_CONFIDENCE_MATCH" : pts >= 0.6 ? "POSSIBLE_MATCH" : "NEW_TRANSACTION";
  return { result, points: pts };
}

async function addEvidence(
  client: Prisma.TransactionClient,
  transactionId: string,
  e: { sourceType: "OPEN_BANKING"; provider: string; providerConnectionId: string; providerAccountId: string; providerTransactionId: string; rawPayloadHash?: string | null },
): Promise<void> {
  await client.transactionEvidence.upsert({
    where: { provider_providerTransactionId: { provider: e.provider, providerTransactionId: e.providerTransactionId } },
    update: { transactionId, observedAt: new Date() },
    create: {
      transactionId,
      sourceType: e.sourceType,
      provider: e.provider,
      providerConnectionId: e.providerConnectionId,
      providerAccountId: e.providerAccountId,
      providerTransactionId: e.providerTransactionId,
      rawPayloadHash: e.rawPayloadHash ?? null,
    },
  });
}

async function runDetection(userId: string, transactionId: string, account: ReconAccount, ptxn: ProviderTransaction, client: Prisma.TransactionClient): Promise<void> {
  const transferConfidence = await detectAndPairInternalTransfer(userId, transactionId, client);
  if (transferConfidence === "CONFIRMED" || transferConfidence === "HIGH") return; // an internal transfer is never a DD
  await detectDirectDebit(
    userId,
    transactionId,
    {
      merchant: ptxn.merchantName ?? ptxn.description ?? null,
      // A provider-flagged Direct Debit gives the DD engine an explicit signal.
      text: ptxn.isDirectDebit ? `${ptxn.description ?? ""} direct debit` : ptxn.description ?? null,
      amountMinor: ptxn.amountMinor,
      accountId: account.id,
      bookedAt: new Date(ptxn.bookedAt),
      direction: ptxn.direction,
      reference: ptxn.reference,
    },
    client,
  );
}

/**
 * Reconcile one provider transaction into the canonical ledger.
 *  - EXACT_MATCH / DUPLICATE: the provider id is already known → update lifecycle
 *    (pending→settled), never a second row.
 *  - HIGH_CONFIDENCE_MATCH: enriches the existing notification transaction with
 *    authoritative provider fields and records provider evidence.
 *  - POSSIBLE_MATCH: creates a new row but links it for review rather than
 *    silently merging unrelated transactions.
 *  - NEW_TRANSACTION: creates a canonical transaction and runs it through the
 *    transfer + Direct Debit + categorisation pipeline, exactly like a notification.
 */
export async function reconcileProviderTransaction(
  userId: string,
  account: ReconAccount,
  ptxn: ProviderTransaction,
  ctx: { provider: string; providerConnectionId: string },
  client: Prisma.TransactionClient,
): Promise<ReconOutcome> {
  const provider = ctx.provider;
  const booked = new Date(ptxn.bookedAt);
  const settled = ptxn.status === "SETTLED";

  // 1) Strong match — the provider transaction id is already known.
  const known = await client.transactionEvidence.findUnique({
    where: { provider_providerTransactionId: { provider, providerTransactionId: ptxn.providerTransactionId } },
    select: { transactionId: true },
  });
  if (known) {
    const existing = await client.transaction.findUnique({ where: { id: known.transactionId }, select: { status: true } });
    // Lifecycle update only (pending → settled); no new row.
    if (existing && existing.status === "PENDING" && settled) {
      await client.transaction.update({ where: { id: known.transactionId }, data: { status: "COMPLETED", settledAt: ptxn.settledAt ? new Date(ptxn.settledAt) : booked } });
      return { result: "EXACT_MATCH", transactionId: known.transactionId };
    }
    return { result: "DUPLICATE", transactionId: known.transactionId };
  }

  // 2) Notification ↔ provider match on the same account.
  const candidates = (await client.transaction.findMany({
    where: {
      userId,
      accountId: account.id,
      parentId: null,
      currency: ptxn.currency,
      amountMinor: BigInt(ptxn.amountMinor),
      direction: ptxn.direction,
      bookedAt: { gte: new Date(booked.getTime() - MATCH_WINDOW_MS), lte: new Date(booked.getTime() + MATCH_WINDOW_MS) },
      evidence: { none: { sourceType: "OPEN_BANKING" } }, // not already provider-sourced
    },
    select: { id: true, bookedAt: true, merchantName: true, description: true, paymentReference: true, status: true },
    orderBy: { bookedAt: "desc" },
    take: 20,
  })) as Candidate[];

  let best: { cand: Candidate; result: ReconResult; points: number } | null = null;
  for (const cand of candidates) {
    const s = score(cand, ptxn);
    if (s.result === "NEW_TRANSACTION") continue;
    if (!best || s.points > best.points) best = { cand, ...s };
  }

  if (best && best.result === "HIGH_CONFIDENCE_MATCH") {
    // Enrich the fast notification transaction with authoritative provider data.
    const cand = best.cand;
    await client.transaction.update({
      where: { id: cand.id },
      data: {
        status: settled ? "COMPLETED" : undefined,
        settledAt: settled ? (ptxn.settledAt ? new Date(ptxn.settledAt) : booked) : undefined,
        merchantName: cand.merchantName ?? ptxn.merchantName ?? undefined,
        paymentReference: cand.paymentReference ?? ptxn.reference ?? undefined,
        recipientName: ptxn.recipientName ?? undefined,
        senderName: ptxn.senderName ?? undefined,
      },
    });
    await addEvidence(client, cand.id, { sourceType: "OPEN_BANKING", provider, providerConnectionId: ctx.providerConnectionId, providerAccountId: ptxn.providerAccountId, providerTransactionId: ptxn.providerTransactionId, rawPayloadHash: ptxn.rawPayloadHash });
    return { result: "HIGH_CONFIDENCE_MATCH", transactionId: cand.id };
  }

  // 3) NEW (or POSSIBLE, which still creates a row but flags it for review).
  const applyBalance = account.balanceAuthority !== "PROVIDER";
  const created = await createTransaction(
    userId,
    {
      accountId: account.id,
      direction: ptxn.direction,
      status: settled ? "COMPLETED" : "PENDING",
      source: "OPEN_BANKING",
      amountMinor: ptxn.amountMinor,
      currency: ptxn.currency,
      bookedAt: booked,
      occurredAt: booked,
      settledAt: ptxn.settledAt ? new Date(ptxn.settledAt) : settled ? booked : null,
      description: ptxn.description ?? ptxn.merchantName ?? "Transaction",
      merchantName: ptxn.merchantName ?? undefined,
      recipientName: ptxn.recipientName ?? undefined,
      senderName: ptxn.senderName ?? undefined,
      paymentReference: ptxn.reference ?? undefined,
      applyBalance,
    },
    client,
  );

  await addEvidence(client, created.id, { sourceType: "OPEN_BANKING", provider, providerConnectionId: ctx.providerConnectionId, providerAccountId: ptxn.providerAccountId, providerTransactionId: ptxn.providerTransactionId, rawPayloadHash: ptxn.rawPayloadHash });

  if (best && best.result === "POSSIBLE_MATCH") {
    await client.transaction.update({ where: { id: created.id }, data: { possibleDuplicateOfId: best.cand.id } });
    return { result: "POSSIBLE_MATCH", transactionId: created.id };
  }

  await runDetection(userId, created.id, account, ptxn, client);
  return { result: "NEW_TRANSACTION", transactionId: created.id };
}
