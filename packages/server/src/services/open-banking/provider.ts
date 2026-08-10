// Provider abstraction (Phase 3). The canonical ledger never couples to a
// specific provider — it talks to this interface only, so new providers are
// pluggable without touching reconciliation or the ledger.

export type ProviderCapability =
  | "ACCOUNTS"
  | "BALANCES"
  | "TRANSACTIONS"
  | "ACCOUNT_HOLDER_NAMES"
  | "DIRECT_DEBIT_MANDATES"
  | "STANDING_ORDERS"
  | "RECURRING_TRANSACTION_INSIGHTS";

export interface ProviderAccount {
  providerAccountId: string;
  displayName?: string | null;
  accountType?: string | null;
  currency: string;
  institutionName?: string | null;
  institutionProviderId?: string | null;
  accountHolderName?: string | null;
  // Masked forms only — full identifiers are never required by the ledger.
  maskedAccountNumber?: string | null;
  maskedSortCode?: string | null;
  maskedIban?: string | null;
  // Opaque provider identifier used ONLY internally to strengthen own-account
  // transfer detection (never exposed to the client or logs in full).
  ownershipKey?: string | null;
  // Balance supplied alongside the account (e.g. Plaid /accounts/get), so a normal
  // sync needs no extra balance call.
  cachedBalanceMinor?: number | null;
  cachedAvailableMinor?: number | null;
}

export interface ProviderBalance {
  providerAccountId: string;
  currentMinor: number;
  availableMinor?: number | null;
  currency: string;
}

export interface ProviderTransaction {
  providerTransactionId: string;
  providerAccountId: string;
  amountMinor: number; // absolute value; sign implied by direction
  currency: string;
  direction: "INCOME" | "EXPENSE";
  status: "PENDING" | "SETTLED";
  bookedAt: string; // ISO
  settledAt?: string | null;
  description?: string | null;
  originalDescription?: string | null;
  merchantName?: string | null;
  senderName?: string | null;
  recipientName?: string | null;
  reference?: string | null;
  category?: string | null;
  isDirectDebit?: boolean;
  // Plaid replaces a pending transaction with a new settled one that references
  // the pending id here — used to converge pending→settled into one canonical row.
  pendingTransactionId?: string | null;
  rawPayloadHash?: string | null;
}

// One page of an incremental cursor sync (Plaid /transactions/sync).
export interface ProviderSyncPage {
  added: ProviderTransaction[];
  modified: ProviderTransaction[];
  removed: string[]; // provider transaction ids
  nextCursor: string;
  hasMore: boolean;
}

export interface ExchangePublicTokenResult {
  secret: ProviderConnectionSecret;
  institutionName?: string | null;
  institutionProviderId?: string | null;
  providerItemId?: string | null;
  consentExpiresAt?: string | null;
}

// End-user details TrueLayer Data v3 requires when creating a data connection
// (name + email or phone). Sent to the provider only to establish the connection.
export interface ProviderUser {
  id?: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface StartConnectionInput {
  userId: string;
  connectionId: string; // our BankConnection id
  state: string; // one-time application CSRF nonce (NOT a provider OAuth state)
  returnUri: string;
  user?: ProviderUser;
}

/** Thrown when a provider does not implement a BankDataProvider capability. */
export class UnsupportedOperationError extends Error {
  constructor(operation: string) {
    super(`Operation not supported by this provider: ${operation}`);
    this.name = "UnsupportedOperationError";
  }
}

export type ConnectionStartMode = "hosted_url" | "link_token";

export interface StartConnectionResult {
  // How the client completes the journey: a hosted browser URL (TrueLayer) or a
  // link token the client SDK consumes (Plaid).
  mode: ConnectionStartMode;
  authorizationUrl?: string; // hosted_url providers
  linkToken?: string; // link_token providers
  // Known at creation for TrueLayer; for Plaid the connection id is only known
  // after the public-token exchange.
  providerConnectionId?: string;
}

// TrueLayer Data v3 does not persist per-user access/refresh tokens: data is read
// with a SERVER client-credentials token plus the connection id, so the only
// per-connection secret we store is the connection id itself.
export interface ProviderConnectionSecret {
  providerConnectionId: string;
}

export type ConnectionState = "ACTIVE" | "REAUTH_REQUIRED" | "EXPIRED" | "REVOKED" | "PENDING";

export interface ResolveConnectionResult {
  status: ConnectionState;
  institutionName?: string | null;
  institutionProviderId?: string | null;
  consentExpiresAt?: string | null;
}

export interface GetTransactionsOptions {
  fromIso?: string;
  toIso?: string;
}

/** A pluggable bank-data provider. */
export interface BankDataProvider {
  readonly name: string;
  capabilities(): Set<ProviderCapability>;
  supportsDirectDebitMandates(): boolean;

  createConnection(input: StartConnectionInput): Promise<StartConnectionResult>;
  // hosted_url providers verify state after the browser returns; link_token
  // providers exchange the client's public token for stored credentials.
  resolveConnection(secret: ProviderConnectionSecret): Promise<ResolveConnectionResult>;
  exchangePublicToken?(publicToken: string): Promise<ExchangePublicTokenResult>;
  getConnectionStatus(secret: ProviderConnectionSecret): Promise<ConnectionState>;
  listAccounts(secret: ProviderConnectionSecret): Promise<ProviderAccount[]>;
  getBalances(secret: ProviderConnectionSecret, providerAccountId: string): Promise<ProviderBalance>;
  // Window-based transaction fetch (per account). Optional — providers that only
  // support incremental cursor sync implement syncTransactions instead.
  getTransactions?(secret: ProviderConnectionSecret, providerAccountId: string, opts?: GetTransactionsOptions): Promise<ProviderTransaction[]>;
  // Incremental cursor sync (Plaid /transactions/sync). Optional.
  syncTransactions?(secret: ProviderConnectionSecret, cursor: string | null): Promise<ProviderSyncPage>;
  revokeConnection(secret: ProviderConnectionSecret): Promise<void>;
}
