package uk.co.prisom.directbanking.domain

/** UI-facing domain models, decoupled from wire DTOs. All money is minor units. */

data class DashboardSummary(
    val incomeMinor: Long,
    val expenseMinor: Long,
    val safeToSpendMinor: Long,
    val totalBalanceMinor: Long,
    val remainingDirectDebitsMinor: Long,
    // Phase 2 Direct Debit analytics.
    val directDebitsThisMonthMinor: Long = 0,
    val directDebitsThisYearMinor: Long = 0,
    val avgMonthlyDirectDebitMinor: Long = 0,
    val upcoming7DaysMinor: Long = 0,
    val upcoming30DaysMinor: Long = 0,
)

/** One upcoming Direct Debit payment for the Home "Upcoming payments" section. */
data class UpcomingPayment(
    val mandateId: String,
    val companyName: String,
    val account: String,
    val expectedDate: String?,
    val expectedAmountMinor: Long,
    val isRange: Boolean = false,
    val expectedMinMinor: Long? = null,
    val expectedMaxMinor: Long? = null,
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

/** Aggregate Open Banking sync status shown on Home (Phase 3). */
data class BankSyncStatus(
    val connectionCount: Int = 0,
    val needsAttention: Int = 0,
    val lastBankSyncAt: String? = null,
)

data class DashboardData(
    val displayName: String?,
    val baseCurrency: String,
    val summary: DashboardSummary,
    val accounts: List<AccountSummary>,
    val directDebits: List<DirectDebitSummary>,
    val pendingImports: Int,
    val upcomingPayments: List<UpcomingPayment> = emptyList(),
    val bankSync: BankSyncStatus = BankSyncStatus(),
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
    // ---- Unified Activity item fields (Financial Event Intelligence round 2) ----
    // `kind`/`lifecycle` are the two fields the UI renders off; everything else
    // here is only ever populated for kind == "FINANCIAL_EVENT" (a non-posted
    // notification-derived event, never a real ledger row).
    val kind: String = "TRANSACTION", // "TRANSACTION" | "FINANCIAL_EVENT"
    val eventKind: String? = null,
    val lifecycle: String = "COMPLETED",
    val expectedAt: String? = null,
    val ledgerPosted: Boolean = true,
    val reasonCode: String? = null,
    val paymentRail: String? = null,
) {
    val isInternalTransfer: Boolean get() = transactionType == "INTERNAL_TRANSFER"
    val isPossibleTransfer: Boolean get() = internalTransferConfidence == "POSSIBLE" && !isInternalTransfer
    val isFinancialEvent: Boolean get() = kind == "FINANCIAL_EVENT"
    // CREDIT_CARD_REPAYMENT is a distinct economic type from ordinary spending
    // (§9 acceptance criteria) — it moves cash but must never render or be
    // labelled as Income, on either a Transaction or a FinancialEvent row.
    val isCreditCardRepayment: Boolean get() = transactionType == "CREDIT_CARD_REPAYMENT" || eventKind == "CREDIT_CARD_REPAYMENT"
}
