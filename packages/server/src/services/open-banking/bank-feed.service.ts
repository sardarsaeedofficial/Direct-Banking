import { randomBytes } from "node:crypto";
import type { BankConnection, Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { setProviderBalance } from "../transactions.service.js";
import { encryptJson, decryptJson } from "./crypto.js";
import { getProvider } from "./registry.js";
import type { BankDataProvider, ProviderAccount, ProviderConnectionSecret } from "./provider.js";
import { reconcileProviderTransaction, type ReconResult } from "./reconciliation.service.js";

const AUTH_STATE_TTL_MS = 10 * 60_000;
const SYNC_OVERLAP_MS = 24 * 60 * 60_000;
const HISTORY_WINDOW_MS = 730 * 24 * 60 * 60_000; // ~2 years, subject to provider limits

function requireProvider(): BankDataProvider {
  const p = getProvider();
  if (!p) throw new Error("Open Banking provider is not configured");
  return p;
}

function readSecret(conn: BankConnection): ProviderConnectionSecret {
  if (!conn.providerConnectionIdEncrypted) throw new Error("Connection has no stored credentials");
  return decryptJson<ProviderConnectionSecret>(conn.providerConnectionIdEncrypted);
}

/** Begin a connection: create a PENDING row with a one-time state and the hosted auth URL. */
export async function startConnection(userId: string, deviceId: string | null, returnUri: string) {
  const provider = requireProvider();
  const state = randomBytes(24).toString("base64url");
  const conn = await prisma.bankConnection.create({
    data: {
      userId,
      provider: provider.name,
      status: "AUTHORIZATION_REQUIRED",
      authState: state,
      authStateExpiresAt: new Date(Date.now() + AUTH_STATE_TTL_MS),
      authDeviceId: deviceId,
    },
  });
  const { authorizationUrl } = await provider.createConnection({ userId, connectionId: conn.id, state, returnUri });
  return { connectionId: conn.id, authorizationUrl };
}

/**
 * Handle the provider authorization callback. Validates the one-time state (bound
 * to a connection, unexpired, unconsumed), exchanges the code for tokens, stores
 * them encrypted, activates the connection and kicks off the initial import.
 * Returns null when the state is invalid/reused (never silently reconnect).
 */
export async function handleCallback(state: string, code: string): Promise<{ connectionId: string; userId: string } | null> {
  const provider = requireProvider();
  const conn = await prisma.bankConnection.findUnique({ where: { authState: state } });
  if (!conn || !conn.authStateExpiresAt || conn.authStateExpiresAt < new Date()) return null;
  if (conn.status === "REVOKED") return null;

  // Consume the state atomically so it can never be replayed.
  const claim = await prisma.bankConnection.updateMany({
    where: { id: conn.id, authState: state },
    data: { authState: null, authStateExpiresAt: null },
  });
  if (claim.count === 0) return null;

  try {
    const result = await provider.exchangeCallback({ code, connectionId: conn.id });
    await prisma.bankConnection.update({
      where: { id: conn.id },
      data: {
        providerConnectionIdEncrypted: encryptJson(result.secret),
        status: "ACTIVE",
        institutionName: result.institutionName ?? conn.institutionName,
        institutionProviderId: result.institutionProviderId ?? conn.institutionProviderId,
        consentGrantedAt: new Date(),
        consentExpiresAt: result.consentExpiresAt ? new Date(result.consentExpiresAt) : null,
      },
    });
    // Initial historical import (best-effort; failures leave the connection ACTIVE with an error stamp).
    await syncConnection(conn.userId, conn.id, { historical: true }).catch(() => undefined);
    return { connectionId: conn.id, userId: conn.userId };
  } catch {
    await prisma.bankConnection.update({ where: { id: conn.id }, data: { status: "ERROR", lastErrorAt: new Date(), lastErrorCode: "TOKEN_EXCHANGE_FAILED" } });
    return { connectionId: conn.id, userId: conn.userId };
  }
}

export async function reauthorize(userId: string, connectionId: string, deviceId: string | null, returnUri: string) {
  const provider = requireProvider();
  const conn = await prisma.bankConnection.findFirst({ where: { id: connectionId, userId } });
  if (!conn) return null;
  const state = randomBytes(24).toString("base64url");
  await prisma.bankConnection.update({
    where: { id: conn.id },
    data: { status: "AUTHORIZATION_REQUIRED", authState: state, authStateExpiresAt: new Date(Date.now() + AUTH_STATE_TTL_MS), authDeviceId: deviceId },
  });
  const { authorizationUrl } = await provider.createConnection({ userId, connectionId: conn.id, state, returnUri });
  return { connectionId: conn.id, authorizationUrl };
}

export async function revokeConnection(userId: string, connectionId: string): Promise<boolean> {
  const provider = requireProvider();
  const conn = await prisma.bankConnection.findFirst({ where: { id: connectionId, userId } });
  if (!conn) return false;
  try {
    if (conn.providerConnectionIdEncrypted) await provider.revokeConnection(readSecret(conn));
  } catch {
    // Best-effort; we still mark it revoked locally.
  }
  // Stop future sync; keep financial history. Drop stored tokens.
  await prisma.bankConnection.update({ where: { id: conn.id }, data: { status: "REVOKED", providerConnectionIdEncrypted: null } });
  await prisma.bankAccount.updateMany({ where: { userId, bankConnectionId: conn.id }, data: { balanceAuthority: "LEDGER" } });
  return true;
}

/** Find/link/create the BankAccount for a provider account without duplicating a manual account. */
async function linkOrCreateAccount(userId: string, conn: BankConnection, pAcc: ProviderAccount): Promise<string> {
  // 1) Already linked by provider account id → reuse.
  const linked = await prisma.bankAccount.findFirst({ where: { userId, providerAccountId: pAcc.providerAccountId } });
  if (linked) {
    await prisma.bankAccount.update({
      where: { id: linked.id },
      data: {
        balanceAuthority: "PROVIDER", bankConnectionId: conn.id, providerOwnershipKey: pAcc.ownershipKey ?? undefined,
        accountHolderName: pAcc.accountHolderName ?? linked.accountHolderName,
        sortCodeMasked: pAcc.maskedSortCode ?? linked.sortCodeMasked,
        accountNumberMasked: pAcc.maskedAccountNumber ?? linked.accountNumberMasked,
        ibanMasked: pAcc.maskedIban ?? linked.ibanMasked,
      },
    });
    return linked.id;
  }
  // 2) Safe match to an existing manual account (same bank + currency, not yet linked).
  const bankName = pAcc.institutionName ?? pAcc.displayName ?? "Bank";
  const manual = await prisma.bankAccount.findFirst({
    where: { userId, providerAccountId: null, currency: pAcc.currency, bankName: { equals: bankName, mode: "insensitive" } },
  });
  if (manual) {
    await prisma.bankAccount.update({
      where: { id: manual.id },
      data: {
        providerAccountId: pAcc.providerAccountId, balanceAuthority: "PROVIDER", bankConnectionId: conn.id, providerOwnershipKey: pAcc.ownershipKey ?? undefined,
        accountHolderName: pAcc.accountHolderName ?? manual.accountHolderName,
        sortCodeMasked: pAcc.maskedSortCode ?? manual.sortCodeMasked,
        accountNumberMasked: pAcc.maskedAccountNumber ?? manual.accountNumberMasked,
        ibanMasked: pAcc.maskedIban ?? manual.ibanMasked,
      },
    });
    return manual.id;
  }
  // 3) Create a new provider-authoritative account.
  const created = await prisma.bankAccount.create({
    data: {
      userId, bankName, nickname: pAcc.displayName ?? bankName, currency: pAcc.currency,
      providerAccountId: pAcc.providerAccountId, balanceAuthority: "PROVIDER", bankConnectionId: conn.id, providerOwnershipKey: pAcc.ownershipKey,
      accountHolderName: pAcc.accountHolderName ?? null,
      sortCodeMasked: pAcc.maskedSortCode ?? null, accountNumberMasked: pAcc.maskedAccountNumber ?? null, ibanMasked: pAcc.maskedIban ?? null,
    },
  });
  return created.id;
}

export interface SyncSummary {
  accountsLinked: number;
  imported: number;
  matched: number;
  duplicates: number;
}

/**
 * Refresh accounts, authoritative balances and transactions for a connection,
 * reconcile them into the canonical ledger, and update sync state. Idempotent:
 * re-running never double-imports or double-applies balances. Failures preserve
 * existing data and record an error stamp for later retry.
 */
export async function syncConnection(userId: string, connectionId: string, opts: { historical?: boolean } = {}): Promise<SyncSummary> {
  const provider = requireProvider();
  const conn = await prisma.bankConnection.findFirst({ where: { id: connectionId, userId } });
  if (!conn) throw new Error("Connection not found");
  if (conn.status === "REVOKED" || conn.status === "EXPIRED") throw new Error("Connection cannot sync");

  const summary: SyncSummary = { accountsLinked: 0, imported: 0, matched: 0, duplicates: 0 };
  await prisma.bankConnection.update({ where: { id: conn.id }, data: { lastSyncedAt: new Date() } });

  try {
    const secret = readSecret(conn);
    const providerAccounts = await provider.listAccounts(secret);
    const fromIso = new Date(
      opts.historical ? Date.now() - HISTORY_WINDOW_MS : (conn.lastSuccessfulSyncAt?.getTime() ?? Date.now() - HISTORY_WINDOW_MS) - SYNC_OVERLAP_MS,
    ).toISOString();

    for (const pAcc of providerAccounts) {
      const accountId = await linkOrCreateAccount(userId, conn, pAcc);
      summary.accountsLinked++;

      // Authoritative balance (overwrites — never sums history).
      const balance = await provider.getBalances(secret, pAcc.providerAccountId);
      await prisma.$transaction((tx) => setProviderBalance(tx, accountId, balance.currentMinor, balance.availableMinor));

      const account = { id: accountId, currency: pAcc.currency, balanceAuthority: "PROVIDER" as const };
      const txns = await provider.getTransactions(secret, pAcc.providerAccountId, { fromIso });
      for (const ptxn of txns) {
        const outcome: ReconResult = (
          await prisma.$transaction((tx: Prisma.TransactionClient) =>
            reconcileProviderTransaction(userId, account, ptxn, { provider: provider.name, providerConnectionId: conn.id }, tx),
          )
        ).result;
        if (outcome === "DUPLICATE") summary.duplicates++;
        else if (outcome === "HIGH_CONFIDENCE_MATCH" || outcome === "EXACT_MATCH") summary.matched++;
        else summary.imported++;
      }
    }

    await prisma.bankConnection.update({
      where: { id: conn.id },
      data: { lastSuccessfulSyncAt: new Date(), lastErrorCode: null, historyImportedAt: opts.historical ? new Date() : conn.historyImportedAt },
    });
    return summary;
  } catch (err) {
    // Preserve all existing data; record a sanitised error for retry.
    const code = err instanceof Error && err.message === "REAUTH_REQUIRED" ? "REAUTH_REQUIRED" : "SYNC_FAILED";
    await prisma.bankConnection.update({
      where: { id: conn.id },
      data: { lastErrorAt: new Date(), lastErrorCode: code, status: code === "REAUTH_REQUIRED" ? "REAUTH_REQUIRED" : conn.status },
    });
    throw new Error(code);
  }
}
