package uk.co.prisom.directbanking.data.remote.dto

import kotlinx.serialization.Serializable

// Phase 4 — financial insights, budgets, categories, recurring payments, activity.
// Money is always integer minor units (Long). DTOs are partial by design: the API's
// JSON reader ignores unknown keys, so only the fields the UI uses are declared.

// ── Insights ──────────────────────────────────────────────────────────────────
@Serializable data class DateRangeDto(val startIso: String = "", val endIso: String = "")

@Serializable
data class CurrencySummaryDto(
    val currency: String = "GBP",
    val incomeMinor: Long = 0,
    val spendingMinor: Long = 0,
    val netMinor: Long = 0,
    val savingsRateBps: Int? = null,
)

@Serializable
data class PeriodSummaryDto(
    val range: DateRangeDto = DateRangeDto(),
    val primaryCurrency: String = "GBP",
    val currencies: List<CurrencySummaryDto> = emptyList(),
)

@Serializable
data class ComparisonMetricDto(
    val currentMinor: Long = 0,
    val previousMinor: Long = 0,
    val deltaMinor: Long = 0,
    val changePct: Double? = null,
)

@Serializable
data class ComparisonDto(
    val currency: String = "GBP",
    val income: ComparisonMetricDto = ComparisonMetricDto(),
    val spending: ComparisonMetricDto = ComparisonMetricDto(),
    val net: ComparisonMetricDto = ComparisonMetricDto(),
)

@Serializable
data class PeriodComparisonDto(
    val basis: String = "month",
    val currency: String = "GBP",
    val comparisons: List<ComparisonDto> = emptyList(),
)

@Serializable
data class CategorySliceDto(
    val categoryId: String? = null,
    val name: String = "",
    val code: String? = null,
    val colour: String = "#64748b",
    val spentMinor: Long = 0,
    val txnCount: Int = 0,
    val pctBps: Int = 0,
)

@Serializable
data class CategoryBreakdownDto(
    val range: DateRangeDto = DateRangeDto(),
    val currency: String = "GBP",
    val totalMinor: Long = 0,
    val categories: List<CategorySliceDto> = emptyList(),
)

@Serializable
data class MerchantSliceDto(
    val merchantId: String = "",
    val displayName: String = "",
    val spentMinor: Long = 0,
    val txnCount: Int = 0,
)

@Serializable
data class TopMerchantsDto(
    val range: DateRangeDto = DateRangeDto(),
    val currency: String = "GBP",
    val merchants: List<MerchantSliceDto> = emptyList(),
)

@Serializable
data class NetWorthAccountDto(
    val id: String = "",
    val name: String = "",
    val accountType: String = "",
    val classification: String = "ASSET",
    val balanceMinor: Long = 0,
)

@Serializable
data class NetWorthCurrencyDto(
    val currency: String = "GBP",
    val assetsMinor: Long = 0,
    val liabilitiesMinor: Long = 0,
    val netWorthMinor: Long = 0,
    val unclassifiedMinor: Long = 0,
    val accounts: List<NetWorthAccountDto> = emptyList(),
)

@Serializable data class NetWorthDto(val currencies: List<NetWorthCurrencyDto> = emptyList())

@Serializable
data class SafeToSpendDto(
    val currency: String = "GBP",
    val availableMinor: Long = 0,
    val upcomingCommittedMinor: Long = 0,
    val minReserveMinor: Long = 0,
    val safeToSpendMinor: Long = 0,
    val label: String = "Estimate",
)

@Serializable
data class CashFlowHorizonDto(
    val outflowMinor: Long = 0,
    val inflowMinor: Long = 0,
    val netMinor: Long = 0,
    val projectedBalanceMinor: Long = 0,
)

@Serializable
data class UpcomingPaymentP4Dto(
    val id: String = "",
    val name: String = "",
    val source: String = "",
    val amountMinor: Long = 0,
    val currency: String = "GBP",
    val dueIso: String = "",
    val label: String = "Expected",
)

@Serializable
data class CashFlowForecastDto(
    val currency: String = "GBP",
    val currentBalanceMinor: Long = 0,
    val next7: CashFlowHorizonDto = CashFlowHorizonDto(),
    val next30: CashFlowHorizonDto = CashFlowHorizonDto(),
    val endOfMonth: CashFlowHorizonDto = CashFlowHorizonDto(),
    val label: String = "Estimate",
    val upcoming: List<UpcomingPaymentP4Dto> = emptyList(),
)

// ── Budgets ───────────────────────────────────────────────────────────────────
@Serializable
data class BudgetProgressDto(
    val budgetId: String = "",
    val name: String = "",
    val categoryId: String? = null,
    val categoryName: String? = null,
    val currency: String = "GBP",
    val limitMinor: Long = 0,
    val spentMinor: Long = 0,
    val remainingMinor: Long = 0,
    val pctBps: Int = 0,
    val status: String = "ON_TRACK",
    val periodStartIso: String = "",
    val periodEndIso: String = "",
)

@Serializable data class BudgetListResponse(val items: List<BudgetProgressDto> = emptyList())

@Serializable
data class BudgetCreateRequest(
    val name: String,
    val categoryId: String? = null,
    val period: String = "MONTHLY",
    val limitMinor: Long,
    val currency: String = "GBP",
    val startDate: String,
    val endDate: String? = null,
    val rolloverEnabled: Boolean? = null,
    val enabled: Boolean? = null,
    val alert50: Boolean? = null,
    val alert75: Boolean? = null,
    val alert90: Boolean? = null,
    val alert100: Boolean? = null,
)

@Serializable data class BudgetEntityDto(val id: String, val name: String = "", val categoryId: String? = null, val limitMinor: Long = 0, val currency: String = "GBP")
@Serializable data class BudgetMutationResponse(val budget: BudgetEntityDto)

@Serializable
data class BudgetAlertDto(
    val budgetId: String = "",
    val name: String = "",
    val threshold: Int = 0,
    val spentMinor: Long = 0,
    val limitMinor: Long = 0,
    val currency: String = "GBP",
)
@Serializable data class BudgetAlertsResponse(val alerts: List<BudgetAlertDto> = emptyList())

// ── Insights overview (composite) ──────────────────────────────────────────────
@Serializable
data class InsightsOverviewDto(
    val summary: PeriodSummaryDto = PeriodSummaryDto(),
    val comparison: PeriodComparisonDto = PeriodComparisonDto(),
    val budgets: List<BudgetProgressDto> = emptyList(),
    val netWorth: NetWorthDto = NetWorthDto(),
    val safeToSpend: SafeToSpendDto = SafeToSpendDto(),
    val upcoming: List<UpcomingPaymentP4Dto> = emptyList(),
)

// ── Categories ──────────────────────────────────────────────────────────────────
@Serializable
data class CategoryItemDto(
    val id: String,
    val name: String = "",
    val code: String? = null,
    val colour: String = "#64748b",
    val icon: String? = null,
    val parentId: String? = null,
    val isSystem: Boolean = false,
)
@Serializable data class CategoryListResponse(val items: List<CategoryItemDto> = emptyList())
@Serializable data class CategoryCreateRequest(val name: String, val colour: String? = null, val icon: String? = null, val parentId: String? = null)
@Serializable data class CategoryMutationResponse(val category: CategoryItemDto)

// ── Category rules ──────────────────────────────────────────────────────────────
@Serializable
data class CategoryRuleDto(
    val id: String,
    val field: String = "MERCHANT",
    val operator: String = "CONTAINS",
    val value: String = "",
    val categoryId: String = "",
    val subcategoryId: String? = null,
    val priority: Int = 100,
    val enabled: Boolean = true,
)
@Serializable data class CategoryRuleListResponse(val items: List<CategoryRuleDto> = emptyList())
@Serializable
data class CategoryRuleCreateRequest(
    val field: String,
    val operator: String = "CONTAINS",
    val value: String,
    val categoryId: String,
    val subcategoryId: String? = null,
    val priority: Int? = null,
    val enabled: Boolean? = null,
)
@Serializable data class CategoryRuleMutationResponse(val rule: CategoryRuleDto)

// ── Recurring payments ──────────────────────────────────────────────────────────
@Serializable
data class RecurringPaymentItemDto(
    val id: String,
    val companyName: String = "",
    val kind: String = "DIRECT_DEBIT",
    val status: String = "ACTIVE",
    val accountId: String = "",
    val accountName: String = "",
    val expectedAmountMinor: Long = 0,
    val currency: String = "GBP",
    val nextExpectedIso: String? = null,
    val lastAmountMinor: Long? = null,
    val paymentCount: Int = 0,
)

@Serializable
data class RecurringPaymentsViewDto(
    val items: List<RecurringPaymentItemDto> = emptyList(),
    val byKind: Map<String, List<RecurringPaymentItemDto>> = emptyMap(),
    val monthlyTotalMinor: Long = 0,
    val annualTotalMinor: Long = 0,
    val activeCount: Int = 0,
)

@Serializable
data class SubscriptionSuggestionDto(
    val merchantId: String = "",
    val merchantName: String = "",
    val occurrences: Int = 0,
    val averageAmountMinor: Long = 0,
    val medianIntervalDays: Int = 0,
    val confidence: String = "POSSIBLE",
    val kind: String = "SUBSCRIPTION",
)
@Serializable data class SubscriptionSuggestionsResponse(val items: List<SubscriptionSuggestionDto> = emptyList())

@Serializable
data class RecurringPaymentPatchRequest(
    val status: String? = null,
    val userExpectedAmountMinor: Long? = null,
    val userExpectedDate: String? = null,
    val notes: String? = null,
)
@Serializable data class RecurringDetailResponse(val recurring: DirectDebitMandateDto, val payments: List<DdHistoryItemDto> = emptyList())
@Serializable data class RecurringMutationResponse(val recurring: DirectDebitMandateDto)

// ── Merchant profile ────────────────────────────────────────────────────────────
@Serializable
data class MerchantProfileDto(
    val id: String = "",
    val displayName: String = "",
    val categoryId: String? = null,
    val categoryName: String? = null,
    val currency: String = "GBP",
    val totalSpentMinor: Long = 0,
    val thisMonthMinor: Long = 0,
    val thisYearMinor: Long = 0,
    val averageMinor: Long = 0,
    val txnCount: Int = 0,
    val firstSeenIso: String? = null,
    val lastSeenIso: String? = null,
    val highestMinor: Long = 0,
    val isRecurring: Boolean = false,
)
@Serializable data class MerchantProfileResponse(val merchant: MerchantProfileDto)

// ── Activity search (server-side filters + pagination) ─────────────────────────
@Serializable
data class ActivityResponse(
    val items: List<TransactionItemDto> = emptyList(),
    val total: Int = 0,
    val limit: Int = 50,
    val offset: Int = 0,
    val nextOffset: Int? = null,
)
