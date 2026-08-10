// Provider abstraction (Phase 3). The canonical ledger never couples to a
// specific provider — it talks to this interface only, so new providers are
// pluggable without touching reconciliation or the ledger.

export type ProviderCapability =
  | "ACCOUNTS"
  | "BALANCES"
  | "TRANSACTIONS"
  | "ACCOUNT_HOLDER_NAMES"
  | "DIRECT_DEBIT_MANDATES"
  | "STANDING_ORDERS";

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
  merchantName?: string | null;
  senderName?: string | null;
  recipientName?: string | null;
  reference?: string | null;
  category?: string | null;
  isDirectDebit?: boolean;
  rawPayloadHash?: string | null;
}

export interface StartConnectionInput {
  userId: string;
  connectionId: string; // our BankConnection id
  state: string; // one-time application CSRF nonce (NOT a provider OAuth state)
  returnUri: string;
}

export interface StartConnectionResult {
  authorizationUrl: string;
  // TrueLayer Data v3 returns the connection id when the data-connection is created.
  providerConnectionId: string;
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
  // Verify/resolve the connection lifecycle state after the user returns from the
  // hosted journey (Data v3 has no authorization-code exchange).
  resolveConnection(secret: ProviderConnectionSecret): Promise<ResolveConnectionResult>;
  getConnectionStatus(secret: ProviderConnectionSecret): Promise<ConnectionState>;
  listAccounts(secret: ProviderConnectionSecret): Promise<ProviderAccount[]>;
  getBalances(secret: ProviderConnectionSecret, providerAccountId: string): Promise<ProviderBalance>;
  getTransactions(secret: ProviderConnectionSecret, providerAccountId: string, opts?: GetTransactionsOptions): Promise<ProviderTransaction[]>;
  revokeConnection(secret: ProviderConnectionSecret): Promise<void>;
}
