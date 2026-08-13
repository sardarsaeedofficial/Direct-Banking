package uk.co.prisom.directbanking.data.repository

import kotlinx.serialization.json.Json
import uk.co.prisom.directbanking.data.local.db.InsightsCacheDao
import uk.co.prisom.directbanking.data.local.db.InsightsCacheEntity
import uk.co.prisom.directbanking.data.remote.ApiClients
import uk.co.prisom.directbanking.data.remote.dto.ActivityResponse
import uk.co.prisom.directbanking.data.remote.dto.BudgetCreateRequest
import uk.co.prisom.directbanking.data.remote.dto.BudgetProgressDto
import uk.co.prisom.directbanking.data.remote.dto.CashFlowForecastDto
import uk.co.prisom.directbanking.data.remote.dto.CategoryBreakdownDto
import uk.co.prisom.directbanking.data.remote.dto.CategoryItemDto
import uk.co.prisom.directbanking.data.remote.dto.InsightsOverviewDto
import uk.co.prisom.directbanking.data.remote.dto.MerchantProfileDto
import uk.co.prisom.directbanking.data.remote.dto.NetWorthDto
import uk.co.prisom.directbanking.data.remote.dto.RecurringPaymentsViewDto
import uk.co.prisom.directbanking.data.remote.dto.SubscriptionSuggestionDto
import uk.co.prisom.directbanking.data.remote.dto.TopMerchantsDto

/** Staleness-aware wrapper: a payload plus when it was cached (null = fresh/online). */
data class Cached<T>(val data: T, val cachedAtMillis: Long? = null) {
    val isStale: Boolean get() = cachedAtMillis != null
}

/**
 * Reads Phase 4 insights, budgets, categories, recurring payments and activity from
 * the canonical backend. The Home overview is cached write-through in Room so it can
 * render offline (with a staleness indicator). The backend always remains canonical.
 */
class InsightsRepository(
    private val clients: ApiClients,
    private val cacheDao: InsightsCacheDao,
    private val json: Json,
) {
    private companion object { const val KEY_OVERVIEW = "overview" }

    /** Fetch the Home/insights overview, caching it for offline use. On failure, falls
     *  back to the last cached snapshot (flagged stale). Throws only if nothing cached. */
    suspend fun overview(): Cached<InsightsOverviewDto> {
        return try {
            val fresh = clients.authApi.insightsOverview()
            cacheDao.upsert(InsightsCacheEntity(KEY_OVERVIEW, json.encodeToString(InsightsOverviewDto.serializer(), fresh), System.currentTimeMillis()))
            Cached(fresh)
        } catch (e: Throwable) {
            val row = cacheDao.get(KEY_OVERVIEW) ?: throw e
            Cached(json.decodeFromString(InsightsOverviewDto.serializer(), row.json), row.cachedAtMillis)
        }
    }

    suspend fun categories(period: String = "month"): CategoryBreakdownDto = clients.authApi.insightsCategories(period = period)
    suspend fun merchants(period: String = "month", limit: Int = 10): TopMerchantsDto = clients.authApi.insightsMerchants(period = period, limit = limit)
    suspend fun cashFlow(): CashFlowForecastDto = clients.authApi.insightsCashFlow()
    suspend fun netWorth(): NetWorthDto = clients.authApi.insightsNetWorth()

    // Budgets ---------------------------------------------------------------
    suspend fun budgets(): List<BudgetProgressDto> = clients.authApi.listBudgets().items
    suspend fun createBudget(body: BudgetCreateRequest) = clients.authApi.createBudget(body).budget
    suspend fun deleteBudget(id: String) { clients.authApi.deleteBudget(id) }

    // Categories ------------------------------------------------------------
    suspend fun categoryList(): List<CategoryItemDto> = clients.authApi.listCategories().items

    // Recurring payments ----------------------------------------------------
    suspend fun recurring(): RecurringPaymentsViewDto = clients.authApi.recurringPayments()
    suspend fun recurringSuggestions(): List<SubscriptionSuggestionDto> = clients.authApi.recurringSuggestions().items

    // Merchant profile ------------------------------------------------------
    suspend fun merchant(id: String): MerchantProfileDto = clients.authApi.merchantProfile(id).merchant

    // Activity search -------------------------------------------------------
    suspend fun activity(
        q: String? = null,
        categoryId: String? = null,
        accountId: String? = null,
        direction: String? = null,
        type: String? = null,
        settled: String? = null,
        minAmount: Long? = null,
        maxAmount: Long? = null,
        from: String? = null,
        to: String? = null,
        limit: Int = 50,
        offset: Int = 0,
    ): ActivityResponse = clients.authApi.activity(
        q = q, categoryId = categoryId, accountId = accountId, direction = direction, type = type,
        settled = settled, minAmount = minAmount, maxAmount = maxAmount, from = from, to = to, limit = limit, offset = offset,
    )
}
