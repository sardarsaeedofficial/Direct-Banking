import type {
  BankDataProvider,
  ExchangePublicTokenResult,
  ProviderAccount,
  ProviderBalance,
  ProviderCapability,
  ProviderConnectionSecret,
  ProviderSyncPage,
  ProviderTransaction,
  ResolveConnectionResult,
  StartConnectionInput,
  StartConnectionResult,
} from "./provider.js";
import { SyncMutationError } from "./plaid-provider.js";

interface SyncPageSeed {
  added?: ProviderTransaction[];
  modified?: ProviderTransaction[];
  removed?: string[];
}

/**
 * Deterministic Plaid-shaped provider for CI (link token → public-token exchange →
 * cursor sync). Models /transactions/sync as an ordered list of pages keyed by
 * cursor so re-syncing from a persisted cursor is idempotent.
 */
export class FakePlaidProvider implements BankDataProvider {
  readonly name = "plaid";
  private accounts: ProviderAccount[] = [];
  private balances = new Map<string, ProviderBalance>();
  private pages: SyncPageSeed[] = [];
  public lastPublicToken: string | null = null;
  public failMode: null | "list" | "sync" = null;
  public failMutationOnce = false;
  private resolveState: ResolveConnectionResult["status"] = "ACTIVE";

  seedAccounts(accounts: ProviderAccount[]) { this.accounts = accounts; }
  seedBalance(b: ProviderBalance) { this.balances.set(b.providerAccountId, b); }
  seedSyncPages(pages: SyncPageSeed[]) { this.pages = pages; }
  pushSyncPage(page: SyncPageSeed) { this.pages.push(page); }
  setResolveState(s: ResolveConnectionResult["status"]) { this.resolveState = s; }

  capabilities(): Set<ProviderCapability> {
    return new Set<ProviderCapability>(["ACCOUNTS", "BALANCES", "TRANSACTIONS"]);
  }
  supportsDirectDebitMandates(): boolean { return false; }

  async createConnection(input: StartConnectionInput): Promise<StartConnectionResult> {
    return { mode: "link_token", linkToken: `link-${input.connectionId}` };
  }
  async exchangePublicToken(publicToken: string): Promise<ExchangePublicTokenResult> {
    this.lastPublicToken = publicToken;
    return { secret: { providerConnectionId: `access-${publicToken}` }, providerItemId: `item-${publicToken}`, institutionName: "Monzo", institutionProviderId: "monzo" };
  }
  async resolveConnection(): Promise<ResolveConnectionResult> { return { status: this.resolveState }; }
  async getConnectionStatus(): Promise<ResolveConnectionResult["status"]> { return this.resolveState; }

  async listAccounts(): Promise<ProviderAccount[]> {
    if (this.failMode === "list") throw new Error("Provider unavailable");
    return this.accounts;
  }
  async getBalances(_secret: ProviderConnectionSecret, providerAccountId: string): Promise<ProviderBalance> {
    return this.balances.get(providerAccountId) ?? { providerAccountId, currentMinor: 0, availableMinor: 0, currency: "GBP" };
  }

  async syncTransactions(_secret: ProviderConnectionSecret, cursor: string | null): Promise<ProviderSyncPage> {
    if (this.failMode === "sync") throw new Error("Provider unavailable");
    if (this.failMutationOnce) { this.failMutationOnce = false; throw new SyncMutationError(); }
    const idx = cursor == null ? 0 : Number(cursor.replace("cur-", ""));
    if (idx >= this.pages.length) {
      return { added: [], modified: [], removed: [], nextCursor: `cur-${this.pages.length}`, hasMore: false };
    }
    const page = this.pages[idx]!;
    const nextIdx = idx + 1;
    return {
      added: page.added ?? [],
      modified: page.modified ?? [],
      removed: page.removed ?? [],
      nextCursor: `cur-${nextIdx}`,
      hasMore: nextIdx < this.pages.length,
    };
  }

  async revokeConnection(): Promise<void> { /* no-op */ }
}
