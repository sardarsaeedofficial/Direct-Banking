package uk.co.prisom.directbanking.data.remote

import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.HTTP
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query
import uk.co.prisom.directbanking.data.remote.dto.BootstrapResponse
import uk.co.prisom.directbanking.data.remote.dto.DeleteAccountRequest
import uk.co.prisom.directbanking.data.remote.dto.DeletedResponse
import uk.co.prisom.directbanking.data.remote.dto.LoginRequest
import uk.co.prisom.directbanking.data.remote.dto.LoginResponse
import uk.co.prisom.directbanking.data.remote.dto.LogoutRequest
import uk.co.prisom.directbanking.data.remote.dto.MeResponse
import uk.co.prisom.directbanking.data.remote.dto.AutoImportResponse
import uk.co.prisom.directbanking.data.remote.dto.NotifAutoImportRequest
import uk.co.prisom.directbanking.data.remote.dto.NotifImportCreateResponse
import uk.co.prisom.directbanking.data.remote.dto.NotifImportListResponse
import uk.co.prisom.directbanking.data.remote.dto.NotifImportPatchRequest
import uk.co.prisom.directbanking.data.remote.dto.NotifImportPatchResponse
import uk.co.prisom.directbanking.data.remote.dto.NotifImportRequest
import uk.co.prisom.directbanking.data.remote.dto.RefreshRequest
import uk.co.prisom.directbanking.data.remote.dto.RegisterRequest
import uk.co.prisom.directbanking.data.remote.dto.TokenResponse
import uk.co.prisom.directbanking.data.remote.dto.BankConnectionDetailResponse
import uk.co.prisom.directbanking.data.remote.dto.BankConnectionListResponse
import uk.co.prisom.directbanking.data.remote.dto.BankConnectionsReadiness
import uk.co.prisom.directbanking.data.remote.dto.CompleteConnectionRequest
import uk.co.prisom.directbanking.data.remote.dto.OkResponse
import uk.co.prisom.directbanking.data.remote.dto.DdUpdateRequest
import uk.co.prisom.directbanking.data.remote.dto.ReauthorizeResponse
import uk.co.prisom.directbanking.data.remote.dto.RevokeResponse
import uk.co.prisom.directbanking.data.remote.dto.StartConnectionResponse
import uk.co.prisom.directbanking.data.remote.dto.SyncResponse
import uk.co.prisom.directbanking.data.remote.dto.DirectDebitDetailResponse
import uk.co.prisom.directbanking.data.remote.dto.DirectDebitHistoryResponse
import uk.co.prisom.directbanking.data.remote.dto.DirectDebitListResponse
import uk.co.prisom.directbanking.data.remote.dto.DirectDebitUpdateResponse
import uk.co.prisom.directbanking.data.remote.dto.TransactionListResponse
import uk.co.prisom.directbanking.data.remote.dto.TxnCorrectionRequest
import uk.co.prisom.directbanking.data.remote.dto.TxnCorrectionResponse
import uk.co.prisom.directbanking.data.remote.dto.UpcomingPaymentsResponse

/** Retrofit binding for the Direct Banking mobile API (/api/mobile/v1). */
interface MobileApi {
    @POST("api/mobile/v1/auth/register")
    suspend fun register(@Body body: RegisterRequest): LoginResponse

    @POST("api/mobile/v1/auth/login")
    suspend fun login(@Body body: LoginRequest): LoginResponse

    @POST("api/mobile/v1/auth/refresh")
    suspend fun refresh(@Body body: RefreshRequest): TokenResponse

    @POST("api/mobile/v1/auth/logout")
    suspend fun logout(@Body body: LogoutRequest)

    @GET("api/mobile/v1/me")
    suspend fun me(): MeResponse

    // @DELETE does not declare a body in Retrofit; @HTTP(hasBody = true) is the
    // explicit, unambiguous way to send one on a DELETE request.
    @HTTP(method = "DELETE", path = "api/mobile/v1/me", hasBody = true)
    suspend fun deleteAccount(@Body body: DeleteAccountRequest): OkResponse

    @GET("api/mobile/v1/bootstrap")
    suspend fun bootstrap(): BootstrapResponse

    @GET("api/mobile/v1/transactions")
    suspend fun listTransactions(
        @Query("limit") limit: Int = 50,
        @Query("accountId") accountId: String? = null,
    ): TransactionListResponse

    @PATCH("api/mobile/v1/transactions/{id}")
    suspend fun correctTransaction(@Path("id") id: String, @Body body: TxnCorrectionRequest): TxnCorrectionResponse

    // Direct Debits (Phase 2)
    @GET("api/mobile/v1/direct-debits")
    suspend fun listDirectDebits(
        @Query("status") status: String? = null,
        @Query("search") search: String? = null,
        @Query("sort") sort: String? = null,
    ): DirectDebitListResponse

    @GET("api/mobile/v1/direct-debits/{id}")
    suspend fun directDebit(@Path("id") id: String): DirectDebitDetailResponse

    @GET("api/mobile/v1/direct-debits/{id}/history")
    suspend fun directDebitHistory(@Path("id") id: String): DirectDebitHistoryResponse

    @PATCH("api/mobile/v1/direct-debits/{id}")
    suspend fun updateDirectDebit(@Path("id") id: String, @Body body: DdUpdateRequest): DirectDebitUpdateResponse

    @GET("api/mobile/v1/upcoming-payments")
    suspend fun upcomingPayments(@Query("days") days: Int = 7): UpcomingPaymentsResponse

    // Bank connections / Open Banking (Phase 3)
    @GET("api/mobile/v1/bank-connections/readiness")
    suspend fun bankConnectionsReadiness(): BankConnectionsReadiness

    @POST("api/mobile/v1/bank-connections/start")
    suspend fun startBankConnection(): StartConnectionResponse

    @GET("api/mobile/v1/bank-connections")
    suspend fun listBankConnections(): BankConnectionListResponse

    @GET("api/mobile/v1/bank-connections/{id}")
    suspend fun bankConnection(@Path("id") id: String): BankConnectionDetailResponse

    @POST("api/mobile/v1/bank-connections/{id}/complete")
    suspend fun completeBankConnection(@Path("id") id: String, @Body body: CompleteConnectionRequest): OkResponse

    @POST("api/mobile/v1/bank-connections/{id}/sync")
    suspend fun syncBankConnection(@Path("id") id: String): SyncResponse

    @POST("api/mobile/v1/bank-connections/{id}/reauthorize")
    suspend fun reauthorizeBankConnection(@Path("id") id: String): ReauthorizeResponse

    @DELETE("api/mobile/v1/bank-connections/{id}")
    suspend fun deleteBankConnection(@Path("id") id: String): RevokeResponse

    @POST("api/mobile/v1/notification-imports")
    suspend fun createImport(@Body body: NotifImportRequest): NotifImportCreateResponse

    @POST("api/mobile/v1/notification-imports/auto")
    suspend fun autoImport(@Body body: NotifAutoImportRequest): AutoImportResponse

    @GET("api/mobile/v1/notification-imports")
    suspend fun listImports(
        @Query("status") status: String? = null,
        @Query("reviewState") reviewState: String? = null,
    ): NotifImportListResponse

    @PATCH("api/mobile/v1/notification-imports/{id}")
    suspend fun patchImport(@Path("id") id: String, @Body body: NotifImportPatchRequest): NotifImportPatchResponse

    @DELETE("api/mobile/v1/notification-imports/{id}")
    suspend fun deleteImport(@Path("id") id: String): DeletedResponse

    // ── Phase 4 — Insights ────────────────────────────────────────────────────
    @GET("api/mobile/v1/insights/overview")
    suspend fun insightsOverview(): uk.co.prisom.directbanking.data.remote.dto.InsightsOverviewDto

    @GET("api/mobile/v1/insights/categories")
    suspend fun insightsCategories(
        @Query("period") period: String = "month",
        @Query("start") start: String? = null,
        @Query("end") end: String? = null,
    ): uk.co.prisom.directbanking.data.remote.dto.CategoryBreakdownDto

    @GET("api/mobile/v1/insights/merchants")
    suspend fun insightsMerchants(
        @Query("period") period: String = "month",
        @Query("limit") limit: Int = 10,
    ): uk.co.prisom.directbanking.data.remote.dto.TopMerchantsDto

    @GET("api/mobile/v1/insights/cash-flow")
    suspend fun insightsCashFlow(): uk.co.prisom.directbanking.data.remote.dto.CashFlowForecastDto

    @GET("api/mobile/v1/insights/net-worth")
    suspend fun insightsNetWorth(): uk.co.prisom.directbanking.data.remote.dto.NetWorthDto

    @GET("api/mobile/v1/insights/safe-to-spend")
    suspend fun insightsSafeToSpend(@Query("reserve") reserve: Long = 0): uk.co.prisom.directbanking.data.remote.dto.SafeToSpendDto

    // ── Phase 4 — Categories & rules ──────────────────────────────────────────
    @GET("api/mobile/v1/categories")
    suspend fun listCategories(): uk.co.prisom.directbanking.data.remote.dto.CategoryListResponse

    @POST("api/mobile/v1/categories")
    suspend fun createCategory(@Body body: uk.co.prisom.directbanking.data.remote.dto.CategoryCreateRequest): uk.co.prisom.directbanking.data.remote.dto.CategoryMutationResponse

    @DELETE("api/mobile/v1/categories/{id}")
    suspend fun deleteCategory(@Path("id") id: String): DeletedResponse

    @GET("api/mobile/v1/category-rules")
    suspend fun listCategoryRules(): uk.co.prisom.directbanking.data.remote.dto.CategoryRuleListResponse

    @POST("api/mobile/v1/category-rules")
    suspend fun createCategoryRule(@Body body: uk.co.prisom.directbanking.data.remote.dto.CategoryRuleCreateRequest): uk.co.prisom.directbanking.data.remote.dto.CategoryRuleMutationResponse

    @DELETE("api/mobile/v1/category-rules/{id}")
    suspend fun deleteCategoryRule(@Path("id") id: String): DeletedResponse

    // ── Phase 4 — Budgets ─────────────────────────────────────────────────────
    @GET("api/mobile/v1/budgets")
    suspend fun listBudgets(): uk.co.prisom.directbanking.data.remote.dto.BudgetListResponse

    @GET("api/mobile/v1/budgets/alerts")
    suspend fun budgetAlerts(): uk.co.prisom.directbanking.data.remote.dto.BudgetAlertsResponse

    @POST("api/mobile/v1/budgets")
    suspend fun createBudget(@Body body: uk.co.prisom.directbanking.data.remote.dto.BudgetCreateRequest): uk.co.prisom.directbanking.data.remote.dto.BudgetMutationResponse

    @DELETE("api/mobile/v1/budgets/{id}")
    suspend fun deleteBudget(@Path("id") id: String): DeletedResponse

    // ── Phase 4 — Recurring payments ──────────────────────────────────────────
    @GET("api/mobile/v1/recurring-payments")
    suspend fun recurringPayments(): uk.co.prisom.directbanking.data.remote.dto.RecurringPaymentsViewDto

    @GET("api/mobile/v1/recurring-payments/suggestions")
    suspend fun recurringSuggestions(): uk.co.prisom.directbanking.data.remote.dto.SubscriptionSuggestionsResponse

    @GET("api/mobile/v1/recurring-payments/{id}")
    suspend fun recurringPayment(@Path("id") id: String): uk.co.prisom.directbanking.data.remote.dto.RecurringDetailResponse

    @PATCH("api/mobile/v1/recurring-payments/{id}")
    suspend fun patchRecurringPayment(@Path("id") id: String, @Body body: uk.co.prisom.directbanking.data.remote.dto.RecurringPaymentPatchRequest): uk.co.prisom.directbanking.data.remote.dto.RecurringMutationResponse

    // ── Phase 4 — Merchant profile ────────────────────────────────────────────
    @GET("api/mobile/v1/merchants/{id}")
    suspend fun merchantProfile(@Path("id") id: String): uk.co.prisom.directbanking.data.remote.dto.MerchantProfileResponse

    // ── Phase 5 — Statement import ────────────────────────────────────────────
    @POST("api/mobile/v1/statements")
    suspend fun createStatement(@Body body: uk.co.prisom.directbanking.data.remote.dto.StatementCreateRequest): uk.co.prisom.directbanking.data.remote.dto.StatementImportResponse

    @GET("api/mobile/v1/statements")
    suspend fun listStatements(): uk.co.prisom.directbanking.data.remote.dto.StatementListResponse

    @GET("api/mobile/v1/statements/{id}")
    suspend fun statement(@Path("id") id: String): uk.co.prisom.directbanking.data.remote.dto.StatementImportResponse

    @POST("api/mobile/v1/statements/{id}/parse")
    suspend fun parseStatement(@Path("id") id: String): uk.co.prisom.directbanking.data.remote.dto.StatementPreviewResponse

    @GET("api/mobile/v1/statements/{id}/preview")
    suspend fun previewStatement(@Path("id") id: String): uk.co.prisom.directbanking.data.remote.dto.StatementPreviewResponse

    @POST("api/mobile/v1/statements/{id}/import")
    suspend fun importStatement(@Path("id") id: String, @Body body: uk.co.prisom.directbanking.data.remote.dto.StatementImportRequest): uk.co.prisom.directbanking.data.remote.dto.StatementImportResultResponse

    @DELETE("api/mobile/v1/statements/{id}")
    suspend fun deleteStatement(@Path("id") id: String): DeletedResponse

    // ── Phase 5 — Review centre ───────────────────────────────────────────────
    @GET("api/mobile/v1/review")
    suspend fun reviewCentre(): uk.co.prisom.directbanking.data.remote.dto.ReviewCentreDto

    @POST("api/mobile/v1/review/{id}/merge")
    suspend fun reviewMerge(@Path("id") id: String): uk.co.prisom.directbanking.data.remote.dto.ActionResponse

    @POST("api/mobile/v1/review/{id}/keep-separate")
    suspend fun reviewKeepSeparate(@Path("id") id: String): uk.co.prisom.directbanking.data.remote.dto.ActionResponse

    // ── Phase 5 — Manual internal-transfer pairing ────────────────────────────
    @POST("api/mobile/v1/internal-transfers/pair")
    suspend fun pairTransfer(@Body body: uk.co.prisom.directbanking.data.remote.dto.PairRequest): uk.co.prisom.directbanking.data.remote.dto.ActionResponse

    @POST("api/mobile/v1/internal-transfers/unpair")
    suspend fun unpairTransfer(@Body body: uk.co.prisom.directbanking.data.remote.dto.UnpairRequest): uk.co.prisom.directbanking.data.remote.dto.ActionResponse

    // ── Phase 5 — CSV export (raw body, not JSON) ─────────────────────────────
    @retrofit2.http.Streaming
    @GET("api/mobile/v1/export/transactions")
    suspend fun exportTransactions(
        @Query("accountId") accountId: String? = null,
        @Query("categoryId") categoryId: String? = null,
        @Query("type") type: String? = null,
        @Query("from") from: String? = null,
        @Query("to") to: String? = null,
    ): okhttp3.ResponseBody

    // ── Phase 4 — Activity search (server filters + pagination) ────────────────
    @GET("api/mobile/v1/activity")
    suspend fun activity(
        @Query("q") q: String? = null,
        @Query("merchantId") merchantId: String? = null,
        @Query("categoryId") categoryId: String? = null,
        @Query("accountId") accountId: String? = null,
        @Query("direction") direction: String? = null,
        @Query("type") type: String? = null,
        @Query("settled") settled: String? = null,
        @Query("minAmount") minAmount: Long? = null,
        @Query("maxAmount") maxAmount: Long? = null,
        @Query("from") from: String? = null,
        @Query("to") to: String? = null,
        // "all" | "completed" | "pending" | "upcoming" | "declined_failed" — the
        // compact lifecycle selector (round-2 §3), a separate axis from `type`.
        @Query("lifecycle") lifecycle: String? = null,
        @Query("limit") limit: Int = 50,
        @Query("offset") offset: Int = 0,
    ): uk.co.prisom.directbanking.data.remote.dto.ActivityResponse
}
