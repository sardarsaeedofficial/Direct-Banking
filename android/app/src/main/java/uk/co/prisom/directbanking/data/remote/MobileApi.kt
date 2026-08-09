package uk.co.prisom.directbanking.data.remote

import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query
import uk.co.prisom.directbanking.data.remote.dto.BootstrapResponse
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
    @POST("api/mobile/v1/bank-connections/start")
    suspend fun startBankConnection(): StartConnectionResponse

    @GET("api/mobile/v1/bank-connections")
    suspend fun listBankConnections(): BankConnectionListResponse

    @GET("api/mobile/v1/bank-connections/{id}")
    suspend fun bankConnection(@Path("id") id: String): BankConnectionDetailResponse

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
}
