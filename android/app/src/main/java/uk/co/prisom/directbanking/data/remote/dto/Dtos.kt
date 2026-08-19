package uk.co.prisom.directbanking.data.remote.dto

import kotlinx.serialization.Serializable

@Serializable
data class DeviceInfoDto(
    val deviceId: String,
    val model: String? = null,
    val appVersion: String? = null,
    val platform: String = "android",
)

@Serializable
data class LoginRequest(
    val email: String,
    val password: String,
    val totp: String? = null,
    val device: DeviceInfoDto,
)

@Serializable
data class RegisterRequest(
    val email: String,
    val password: String,
    val displayName: String? = null,
    val device: DeviceInfoDto,
)

@Serializable data class RefreshRequest(val refreshToken: String)
@Serializable data class LogoutRequest(val allDevices: Boolean = false)
// Final release completion (§3): confirm is always the literal "DELETE" —
// server-enforced (mobileDeleteAccountSchema), mirrors the Android UI's own
// typed confirmation so intent is proven on both ends independently.
@Serializable data class DeleteAccountRequest(val password: String, val confirm: String = "DELETE")

@Serializable
data class UserDto(
    val id: String,
    val email: String,
    val displayName: String? = null,
    val baseCurrency: String = "GBP",
    val locale: String = "en-GB",
    val twoFactorEnabled: Boolean = false,
)

@Serializable
data class LoginResponse(
    val user: UserDto? = null,
    val accessToken: String,
    val refreshToken: String,
    val expiresIn: Long,
)

@Serializable data class TokenResponse(val accessToken: String, val refreshToken: String, val expiresIn: Long)
@Serializable data class MeResponse(val user: UserDto)

@Serializable
data class AccountDto(
    val id: String,
    val nickname: String = "",
    val bankName: String = "",
    val lastFour: String? = null,
    val currency: String = "GBP",
    val balanceMinor: Long = 0,
    val accountType: String = "CURRENT",
    val colour: String = "#2563eb",
    val icon: String? = null,
)

@Serializable data class CategoryDto(val id: String, val name: String, val colour: String? = null, val icon: String? = null)

@Serializable
data class DirectDebitDto(
    val id: String,
    val merchantName: String = "",
    val expectedAmountMinor: Long = 0,
    val currency: String = "GBP",
    val nextDueDate: String? = null,
    val frequency: String? = null,
)

@Serializable
data class DashboardDto(
    val incomeMinor: Long = 0,
    val expenseMinor: Long = 0,
    val safeToSpendMinor: Long = 0,
    val totalBalanceMinor: Long = 0,
    val remainingDirectDebitsMinor: Long = 0,
    // Phase 2 Direct Debit analytics.
    val directDebitsThisMonthMinor: Long = 0,
    val directDebitsThisYearMinor: Long = 0,
    val avgMonthlyDirectDebitMinor: Long = 0,
    val upcoming7DaysMinor: Long = 0,
    val upcoming30DaysMinor: Long = 0,
    val upcomingPayments: List<UpcomingPaymentDto> = emptyList(),
)

// Phase 2 — Direct Debit engine -------------------------------------------------
@Serializable
data class UpcomingPaymentDto(
    val mandateId: String,
    val companyName: String = "",
    val account: String = "",
    val accountBank: String = "",
    val expectedDate: String? = null,
    val expectedAmountMinor: Long = 0,
    val isRange: Boolean = false,
    val expectedMinMinor: Long? = null,
    val expectedMaxMinor: Long? = null,
)

@Serializable
data class DirectDebitMandateDto(
    val id: String,
    val companyName: String = "",
    val status: String = "ACTIVE",
    val kind: String = "DIRECT_DEBIT",
    val frequency: String = "MONTHLY",
    val expectationMode: String = "LEARNED",
    val effectiveAmountMinor: Long? = null,
    val effectiveMinMinor: Long? = null,
    val effectiveMaxMinor: Long? = null,
    val expectedDayOfMonth: Int? = null,
    val nextExpectedAt: String? = null,
    val lastPaidAt: String? = null,
    val lastAmountMinor: Long? = null,
    val paymentCount: Int = 0,
    val alertDaysBefore: Int = 3,
    val notes: String? = null,
    val account: TxnAccountRef? = null,
)

@Serializable
data class DdStatsDto(
    val paidThisMonthMinor: Long = 0,
    val paidThisYearMinor: Long = 0,
    val averageMinor: Long = 0,
    val medianMinor: Long = 0,
    val highestMinor: Long = 0,
    val lowestMinor: Long = 0,
)

@Serializable
data class DdHistoryItemDto(
    val id: String,
    val amountMinor: Long = 0,
    val currency: String = "GBP",
    val bookedAt: String? = null,
    val ddAnomaly: String? = null,
    val status: String = "COMPLETED",
    val description: String? = null,
)

@Serializable data class DirectDebitListResponse(val items: List<DirectDebitMandateDto> = emptyList())
@Serializable data class DirectDebitDetailResponse(val mandate: DirectDebitMandateDto, val stats: DdStatsDto = DdStatsDto())
@Serializable data class DirectDebitHistoryResponse(val items: List<DdHistoryItemDto> = emptyList())
@Serializable data class DirectDebitUpdateResponse(val mandate: DirectDebitMandateDto)
@Serializable data class UpcomingPaymentsResponse(val items: List<UpcomingPaymentDto> = emptyList(), val totalMinor: Long = 0)

@Serializable
data class DdUpdateRequest(
    val companyName: String? = null,
    val accountId: String? = null,
    val status: String? = null,
    val frequency: String? = null,
    val expectationMode: String? = null,
    val userExpectedAmountMinor: Long? = null,
    val userExpectedMinMinor: Long? = null,
    val userExpectedMaxMinor: Long? = null,
    val userExpectedDate: String? = null,
    val expectedDayOfMonth: Int? = null,
    val alertDaysBefore: Int? = null,
    val amountTolerancePercent: Int? = null,
    val learnFromHistory: Boolean? = null,
    val notes: String? = null,
)

@Serializable
data class BankSyncStatusDto(
    val connectionCount: Int = 0,
    val needsAttention: Int = 0,
    val lastBankSyncAt: String? = null,
)

@Serializable
data class BootstrapResponse(
    val user: UserDto? = null,
    val accounts: List<AccountDto> = emptyList(),
    val categories: List<CategoryDto> = emptyList(),
    val directDebits: List<DirectDebitDto> = emptyList(),
    val dashboard: DashboardDto = DashboardDto(),
    val pendingImports: Int = 0,
    val bankSync: BankSyncStatusDto = BankSyncStatusDto(),
    val serverTime: String? = null,
)

// Phase 3 — Open Banking / bank connections ------------------------------------
@Serializable
data class BankConnectionDto(
    val id: String,
    val provider: String = "",
    val status: String = "PENDING",
    val institutionName: String? = null,
    val consentGrantedAt: String? = null,
    val consentExpiresAt: String? = null,
    val lastSyncedAt: String? = null,
    val lastSuccessfulSyncAt: String? = null,
    val lastErrorAt: String? = null,
    val lastErrorCode: String? = null,
    val createdAt: String? = null,
)

@Serializable
data class ConnectedAccountDto(
    val id: String,
    val nickname: String = "",
    val bankName: String = "",
    val currency: String = "GBP",
    val accountHolderName: String? = null,
    val sortCodeMasked: String? = null,
    val accountNumberMasked: String? = null,
    val ibanMasked: String? = null,
    val balanceMinor: Long = 0,
    val balanceAuthority: String = "LEDGER",
)

@Serializable
data class StartConnectionResponse(
    val connectionId: String,
    val provider: String = "",
    val mode: String = "hosted_url", // "hosted_url" (TrueLayer) | "link_token" (Plaid)
    val authorizationUrl: String? = null,
    val linkToken: String? = null,
)

// Financial Event Intelligence: safe, non-secret Bank Connections readiness
// state — lets the UI show a clear "disabled" / "not configured" reason
// instead of only discovering a problem from a failed start() call.
// `provider`/`environment` are genuinely absent (null) whenever Open Banking
// is disabled, or enabled but no provider has been explicitly named yet
// (OPEN_BANKING_PROVIDER has no server-side default — see registry.ts) — never
// guess a value here either.
@Serializable
data class BankConnectionsReadiness(
    val enabled: Boolean,
    val provider: String? = null,
    val environment: String? = null,
    val configured: Boolean,
    // "DISABLED" | "NOT_CONFIGURED" | "READY" — the single field the UI keys
    // its exact required copy off (see BankConnectionScreens.kt); defaults to
    // the safe "disabled" reading if an older server ever omits it.
    val reason: String = "DISABLED",
    val missing: List<String> = emptyList(),
)

@Serializable data class CompleteConnectionRequest(val publicToken: String)
@Serializable data class OkResponse(val ok: Boolean = false)
@Serializable data class BankConnectionListResponse(val items: List<BankConnectionDto> = emptyList())
@Serializable data class BankConnectionDetailResponse(val connection: BankConnectionDto, val accounts: List<ConnectedAccountDto> = emptyList())
@Serializable data class SyncSummaryDto(val accountsLinked: Int = 0, val imported: Int = 0, val matched: Int = 0, val duplicates: Int = 0)
@Serializable data class SyncResponse(val ok: Boolean = false, val summary: SyncSummaryDto = SyncSummaryDto())
@Serializable
data class ReauthorizeResponse(
    val connectionId: String,
    val provider: String = "",
    val mode: String = "hosted_url",
    val authorizationUrl: String? = null,
    val linkToken: String? = null,
)
@Serializable data class RevokeResponse(val revoked: Boolean = false)

@Serializable
data class NotifImportRequest(
    val fingerprint: String,
    val sourcePackage: String,
    val direction: String,
    val amountMinor: Long,
    val currency: String,
    val merchant: String? = null,
    val accountHint: String? = null,
    val occurredAt: String,
    val confidence: Double,
    val redactedSourceText: String = "",
    val title: String = "",
)

@Serializable
data class NotifImportDto(
    val id: String,
    val sourcePackage: String = "",
    val title: String = "",
    val parsedMerchant: String? = null,
    val parsedAmountMinor: Long? = null,
    val parsedAccount: String? = null,
    val direction: String? = null,
    val currency: String = "GBP",
    val confidence: Double = 0.0,
    val reviewState: String = "DRAFT",
    val status: String = "PENDING",
    val receivedAt: String? = null,
    val redactedText: String? = null,
    val approvedTransactionId: String? = null,
)

@Serializable data class NotifImportCreateResponse(val import: NotifImportDto, val duplicate: Boolean = false)
@Serializable data class NotifImportListResponse(val items: List<NotifImportDto> = emptyList())

@Serializable
data class NotifAutoImportRequest(
    val fingerprint: String,
    val sourcePackage: String,
    val direction: String,
    val amountMinor: Long,
    val currency: String,
    val merchant: String? = null,
    val accountHint: String? = null,
    val occurredAt: String,
    val confidence: Double,
    val redactedSourceText: String = "",
    val title: String = "",
    // Nullable: when the client doesn't yet know which account this belongs to
    // (e.g. a card purchase before its account is mapped), the server attempts
    // to resolve it from accountHint (card/account last 4) instead — see
    // ImportRepository.capture() and AutoImportResult.AccountMappingRequired.
    val accountId: String? = null,
    val categoryId: String? = null,
    // Phase 1 enrichment (all optional; never required).
    val senderName: String? = null,
    val recipientName: String? = null,
    val senderBankName: String? = null,
    val recipientBankName: String? = null,
    val paymentReference: String? = null,
    val paymentReason: String? = null,
)

@Serializable
data class AutoImportResponse(
    val import: NotifImportDto,
    val transaction: TransactionDto? = null,
    val duplicate: Boolean = false,
    val result: String = "AUTO_IMPORTED",
)

@Serializable
data class NotifImportPatchRequest(
    val action: String,
    val amountMinor: Long? = null,
    val direction: String? = null,
    val merchant: String? = null,
    val occurredAt: String? = null,
    val accountId: String? = null,
    val categoryId: String? = null,
    val notes: String? = null,
)

@Serializable data class TransactionDto(val id: String, val amountMinor: Long? = null, val direction: String? = null)
@Serializable data class NotifImportPatchResponse(val import: NotifImportDto, val transaction: TransactionDto? = null)
@Serializable data class DeletedResponse(val deleted: Boolean = false)

// Transactions list (read-only mobile dashboard) --------------------------------
@Serializable data class TxnAccountRef(val nickname: String? = null)
@Serializable data class TxnCategoryRef(val name: String? = null)
@Serializable data class TxnMerchantRef(val displayName: String? = null)

@Serializable
data class TransactionItemDto(
    val id: String,
    val amountMinor: Long = 0,
    val direction: String = "EXPENSE",
    val currency: String = "GBP",
    val description: String? = null,
    val bookedAt: String? = null,
    val status: String = "COMPLETED",
    val account: TxnAccountRef? = null,
    val category: TxnCategoryRef? = null,
    val merchant: TxnMerchantRef? = null,
    // Phase 1 rich ledger fields (all nullable; omitted fields simply aren't shown).
    val transactionType: String? = null,
    val source: String? = null,
    val merchantName: String? = null,
    val senderName: String? = null,
    val senderBankName: String? = null,
    val recipientName: String? = null,
    val recipientBankName: String? = null,
    val paymentReference: String? = null,
    val paymentReason: String? = null,
    val notes: String? = null,
    val subcategory: String? = null,
    val occurredAt: String? = null,
    val settledAt: String? = null,
    val internalTransferGroupId: String? = null,
    val internalTransferConfidence: String? = null,
    // ---- Unified Activity item fields (Financial Event Intelligence round 2) ----
    // Present on every /activity response row; absent (default) on the plain
    // /transactions rows, which are always TRANSACTION/COMPLETED. See
    // UnifiedActivityItem in mobile.routes.ts for the server-side shape.
    val kind: String = "TRANSACTION", // "TRANSACTION" | "FINANCIAL_EVENT"
    val displayName: String? = null,
    val eventKind: String? = null,
    val lifecycle: String? = null, // null on legacy /transactions rows — derive from `status` instead
    val expectedAt: String? = null,
    val ledgerPosted: Boolean = true,
    val reasonCode: String? = null,
    val paymentRail: String? = null,
)

@Serializable data class TransactionListResponse(val items: List<TransactionItemDto> = emptyList(), val count: Int = 0)

// Manual ledger correction --------------------------------------------------
@Serializable
data class TxnCorrectionRequest(
    val transactionType: String? = null,
    val categoryId: String? = null,
    val subcategory: String? = null,
    val senderName: String? = null,
    val senderBankName: String? = null,
    val recipientName: String? = null,
    val recipientBankName: String? = null,
    val notes: String? = null,
    val paymentReason: String? = null,
    val paymentReference: String? = null,
    val markInternalTransfer: Boolean? = null,
    val counterpartyAccountId: String? = null,
    val markDirectDebit: Boolean? = null,
    val directDebitCompany: String? = null,
)

@Serializable data class TxnCorrectionResponse(val transaction: TransactionItemDto)
