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
import uk.co.prisom.directbanking.data.remote.dto.TransactionListResponse
import uk.co.prisom.directbanking.data.remote.dto.TxnCorrectionRequest
import uk.co.prisom.directbanking.data.remote.dto.TxnCorrectionResponse

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
