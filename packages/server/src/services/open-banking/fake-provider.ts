import type {
  BankDataProvider,
  ExchangeCallbackInput,
  ExchangeCallbackResult,
  GetTransactionsOptions,
  ProviderAccount,
  ProviderBalance,
  ProviderCapability,
  ProviderConnectionSecret,
  ProviderTransaction,
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
  public lastCode: string | null = null;
  public failMode: null | "list" | "txns" = null;

  seedAccounts(accounts: ProviderAccount[]) { this.accounts = accounts; }
  seedBalance(b: ProviderBalance) { this.balances.set(b.providerAccountId, b); }
  seedTransactions(providerAccountId: string, txns: ProviderTransaction[]) { this.txns.set(providerAccountId, txns); }
  setSupportsDirectDebitMandates(v: boolean) { this.ddMandates = v; }

  capabilities(): Set<ProviderCapability> {
    return new Set<ProviderCapability>(["ACCOUNTS", "BALANCES", "TRANSACTIONS", "ACCOUNT_HOLDER_NAMES"]);
  }
  supportsDirectDebitMandates(): boolean { return this.ddMandates; }

  async createConnection(input: StartConnectionInput): Promise<StartConnectionResult> {
    return { authorizationUrl: `https://auth.example/authorize?state=${input.state}&connection=${input.connectionId}` };
  }
  async exchangeCallback(input: ExchangeCallbackInput): Promise<ExchangeCallbackResult> {
    this.lastCode = input.code;
    return {
      secret: { providerConnectionId: `conn-${input.connectionId}`, accessToken: "fake-access", refreshToken: "fake-refresh", expiresAt: null },
      institutionName: "Monzo",
      institutionProviderId: "monzo",
      consentExpiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    };
  }
  async getConnectionStatus(): Promise<"ACTIVE"> { return "ACTIVE"; }
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
