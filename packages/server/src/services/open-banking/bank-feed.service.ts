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

function requireProvider(): BankDataProvider {
  const p = getProvider();
  if (!p) throw new Error("Open Banking provider is not configured");
  return p;
}

function readSecret(conn: BankConnection): ProviderConnectionSecret {
  if (!conn.providerConnectionIdEncrypted) throw new Error("Connection has no stored credentials");
  return decryptJson<ProviderConnectionSecret>(conn.providerConnectionIdEncrypted);
}

/**
 * Begin a Data v3 connection. Creates our BankConnection row, calls
 * POST /v3/data-connections to obtain the connection id + hosted authorization
 * URI, and stores the connection id (encrypted) immediately. Our one-time state
 * nonce protects the user journey and is bound to this connection + device.
 */
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
  // Data v3 requires end-user details (name + email/phone) to create the connection.
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, displayName: true } });
  const { authorizationUrl, providerConnectionId } = await provider.createConnection({
    userId,
    connectionId: conn.id,
    state,
    returnUri,
    user: { id: userId, name: u?.displayName ?? "Direct Banking user", email: u?.email ?? null },
  });
  await prisma.bankConnection.update({
    where: { id: conn.id },
    // Store only the connection id — Data v3 needs no per-user access/refresh tokens.
    data: { providerConnectionIdEncrypted: encryptJson({ providerConnectionId } satisfies ProviderConnectionSecret) },
  });
  return { connectionId: conn.id, authorizationUrl };
}

/**
 * Handle the provider return (Data v3 has no authorization-code exchange).
 * Validates our one-time state (bound to a connection, unexpired, unconsumed),
 * resolves the connection lifecycle state, and — when authorized — activates the
 * connection and kicks off the initial import. Returns null when the state is
 * invalid/reused (never silently reconnect).
 */
export async function handleCallback(state: string): Promise<{ connectionId: string; userId: string } | null> {
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
  if (!conn.providerConnectionIdEncrypted) return null;

  try {
    const resolved = await provider.resolveConnection(readSecret(conn));
    if (resolved.status !== "ACTIVE") {
      await prisma.bankConnection.update({
        where: { id: conn.id },
        data: { status: resolved.status === "PENDING" ? "AUTHORIZATION_REQUIRED" : resolved.status, lastErrorAt: new Date(), lastErrorCode: "NOT_AUTHORIZED" },
      });
      return { connectionId: conn.id, userId: conn.userId };
    }
    await prisma.bankConnection.update({
      where: { id: conn.id },
      data: {
        status: "ACTIVE",
        institutionName: resolved.institutionName ?? conn.institutionName,
        institutionProviderId: resolved.institutionProviderId ?? conn.institutionProviderId,
        consentGrantedAt: new Date(),
        consentExpiresAt: resolved.consentExpiresAt ? new Date(resolved.consentExpiresAt) : null,
      },
    });
    // Initial historical import (best-effort; failures leave the connection ACTIVE with an error stamp).
    await syncConnection(conn.userId, conn.id, { historical: true }).catch(() => undefined);
    return { connectionId: conn.id, userId: conn.userId };
  } catch {
    await prisma.bankConnection.update({ where: { id: conn.id }, data: { status: "ERROR", lastErrorAt: new Date(), lastErrorCode: "RESOLVE_FAILED" } });
    return { connectionId: conn.id, userId: conn.userId };
  }
}

/** Re-run authorization: create a fresh Data v3 connection for the same row. */
export async function reauthorize(userId: string, connectionId: string, deviceId: string | null, returnUri: string) {
  const provider = requireProvider();
  const conn = await prisma.bankConnection.findFirst({ where: { id: connectionId, userId } });
  if (!conn) return null;
  const state = randomBytes(24).toString("base64url");
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, displayName: true } });
  const { authorizationUrl, providerConnectionId } = await provider.createConnection({
    userId, connectionId: conn.id, state, returnUri,
    user: { id: userId, name: u?.displayName ?? "Direct Banking user", email: u?.email ?? null },
  });
  await prisma.bankConnection.update({
    where: { id: conn.id },
    data: {
      status: "AUTHORIZATION_REQUIRED",
      authState: state,
      authStateExpiresAt: new Date(Date.now() + AUTH_STATE_TTL_MS),
      authDeviceId: deviceId,
      providerConnectionIdEncrypted: encryptJson({ providerConnectionId } satisfies ProviderConnectionSecret),
    },
  });
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

/**
 * Find/link/create the BankAccount for a provider account without duplicating a
 * manual account. An account only becomes PROVIDER-authoritative when the provider
 * can actually supply balances (otherwise it stays LEDGER — Data v3 gives accounts
 * but not balances, so linked accounts still improve own-account transfer detection
 * via ownership keys/holder names while balances continue coming from notifications).
 */
async function linkOrCreateAccount(userId: string, conn: BankConnection, pAcc: ProviderAccount, providerAuthoritative: boolean): Promise<string> {
  const authority = providerAuthoritative ? ("PROVIDER" as const) : undefined; // undefined = leave existing (defaults LEDGER on create)
  // 1) Already linked by provider account id → reuse.
  const linked = await prisma.bankAccount.findFirst({ where: { userId, providerAccountId: pAcc.providerAccountId } });
  if (linked) {
    await prisma.bankAccount.update({
      where: { id: linked.id },
      data: {
        balanceAuthority: authority, bankConnectionId: conn.id, providerOwnershipKey: pAcc.ownershipKey ?? undefined,
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
        providerAccountId: pAcc.providerAccountId, balanceAuthority: authority, bankConnectionId: conn.id, providerOwnershipKey: pAcc.ownershipKey ?? undefined,
        accountHolderName: pAcc.accountHolderName ?? manual.accountHolderName,
        sortCodeMasked: pAcc.maskedSortCode ?? manual.sortCodeMasked,
        accountNumberMasked: pAcc.maskedAccountNumber ?? manual.accountNumberMasked,
        ibanMasked: pAcc.maskedIban ?? manual.ibanMasked,
      },
    });
    return manual.id;
  }
  // 3) Create a new account (PROVIDER-authoritative only when balances are available).
  const created = await prisma.bankAccount.create({
    data: {
      userId, bankName, nickname: pAcc.displayName ?? bankName, currency: pAcc.currency,
      providerAccountId: pAcc.providerAccountId, balanceAuthority: providerAuthoritative ? "PROVIDER" : "LEDGER", bankConnectionId: conn.id, providerOwnershipKey: pAcc.ownershipKey,
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
    // Gate work on what the provider actually supports. TrueLayer Data v3 supplies
    // accounts (+ holder names) but not balances/transactions, so those steps are
    // skipped for it while the rest of Direct Banking keeps working.
    const caps = provider.capabilities();
    const hasBalances = caps.has("BALANCES");
    const hasTransactions = caps.has("TRANSACTIONS");

    const providerAccounts = await provider.listAccounts(secret);
    // Do not assume a fixed history depth. On the initial import let the provider
    // return whatever history the provider/consent makes available; afterwards sync
    // incrementally from the persisted checkpoint (with a small overlap).
    const fromIso = opts.historical || !conn.lastSuccessfulSyncAt
      ? undefined
      : new Date(conn.lastSuccessfulSyncAt.getTime() - SYNC_OVERLAP_MS).toISOString();

    for (const pAcc of providerAccounts) {
      const accountId = await linkOrCreateAccount(userId, conn, pAcc, hasBalances);
      summary.accountsLinked++;

      // Authoritative balance (overwrites — never sums history), when supported.
      if (hasBalances) {
        const balance = await provider.getBalances(secret, pAcc.providerAccountId);
        await prisma.$transaction((tx) => setProviderBalance(tx, accountId, balance.currentMinor, balance.availableMinor));
      }

      if (!hasTransactions) continue;
      const account = { id: accountId, currency: pAcc.currency, balanceAuthority: hasBalances ? ("PROVIDER" as const) : ("LEDGER" as const) };
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
