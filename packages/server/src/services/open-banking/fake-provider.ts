import type {
  BankDataProvider,
  ConnectionState,
  GetTransactionsOptions,
  ProviderAccount,
  ProviderBalance,
  ProviderCapability,
  ProviderConnectionSecret,
  ProviderTransaction,
  ResolveConnectionResult,
  StartConnectionInput,
  StartConnectionResult,
} from "./provider.js";

/**
 * Deterministic in-memory provider used by CI (no real TrueLayer credentials).
 * Tests script accounts/balances/transactions and drive the full connection flow.
 */
export class FakeBankDataProvider implements BankDataProvider {
  readonly name = "truelayer";
  private accounts: ProviderAccount[] = [];
  private balances = new Map<string, ProviderBalance>();
  private txns = new Map<string, ProviderTransaction[]>();
  private ddMandates = false;
  public failMode: null | "list" | "txns" = null;
  private resolveState: ConnectionState = "ACTIVE";

  seedAccounts(accounts: ProviderAccount[]) { this.accounts = accounts; }
  seedBalance(b: ProviderBalance) { this.balances.set(b.providerAccountId, b); }
  seedTransactions(providerAccountId: string, txns: ProviderTransaction[]) { this.txns.set(providerAccountId, txns); }
  setSupportsDirectDebitMandates(v: boolean) { this.ddMandates = v; }

  capabilities(): Set<ProviderCapability> {
    return new Set<ProviderCapability>(["ACCOUNTS", "BALANCES", "TRANSACTIONS", "ACCOUNT_HOLDER_NAMES"]);
  }
  supportsDirectDebitMandates(): boolean { return this.ddMandates; }

  setResolveState(s: ConnectionState) { this.resolveState = s; }

  async createConnection(input: StartConnectionInput): Promise<StartConnectionResult> {
    return {
      authorizationUrl: `https://auth.example/authorize?state=${input.state}&connection=${input.connectionId}`,
      providerConnectionId: `conn-${input.connectionId}`,
    };
  }
  async resolveConnection(_secret: ProviderConnectionSecret): Promise<ResolveConnectionResult> {
    return {
      status: this.resolveState,
      institutionName: "Monzo",
      institutionProviderId: "monzo",
      consentExpiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    };
  }
  async getConnectionStatus(): Promise<ConnectionState> { return this.resolveState; }
  async listAccounts(_secret: ProviderConnectionSecret): Promise<ProviderAccount[]> {
    if (this.failMode === "list") throw new Error("Provider unavailable");
    return this.accounts;
  }
  async getBalances(_secret: ProviderConnectionSecret, providerAccountId: string): Promise<ProviderBalance> {
    return this.balances.get(providerAccountId) ?? { providerAccountId, currentMinor: 0, availableMinor: 0, currency: "GBP" };
  }
  async getTransactions(_secret: ProviderConnectionSecret, providerAccountId: string, _opts?: GetTransactionsOptions): Promise<ProviderTransaction[]> {
    if (this.failMode === "txns") throw new Error("Provider unavailable");
    return this.txns.get(providerAccountId) ?? [];
  }
  async revokeConnection(): Promise<void> { /* no-op */ }
}
