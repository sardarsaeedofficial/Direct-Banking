package uk.co.prisom.directbanking.domain

/** UI-facing domain models, decoupled from wire DTOs. All money is minor units. */

data class DashboardSummary(
    val incomeMinor: Long,
    val expenseMinor: Long,
    val safeToSpendMinor: Long,
    val totalBalanceMinor: Long,
    val remainingDirectDebitsMinor: Long,
)

data class AccountSummary(
    val id: String,
    val nickname: String,
    val bankName: String,
    val lastFour: String?,
    val currency: String,
    val balanceMinor: Long,
    val colour: String,
)

data class DirectDebitSummary(
    val id: String,
    val merchantName: String,
    val expectedAmountMinor: Long,
    val currency: String,
    val nextDueDate: String?,
)

data class DashboardData(
    val displayName: String?,
    val baseCurrency: String,
    val summary: DashboardSummary,
    val accounts: List<AccountSummary>,
    val directDebits: List<DirectDebitSummary>,
    val pendingImports: Int,
)

data class TransactionSummary(
    val id: String,
    val amountMinor: Long,
    val direction: String,
    val currency: String,
    val description: String,
    val merchant: String?,
    val category: String?,
    val account: String?,
    val bookedAt: String?,
    val status: String,
    // ---- Phase 1 rich ledger fields (nullable; absent fields are simply hidden) ----
    val transactionType: String? = null,
    val source: String? = null,
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
) {
    val isInternalTransfer: Boolean get() = transactionType == "INTERNAL_TRANSFER"
    val isPossibleTransfer: Boolean get() = internalTransferConfidence == "POSSIBLE" && !isInternalTransfer
}
