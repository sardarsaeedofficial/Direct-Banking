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
import uk.co.prisom.directbanking.data.remote.dto.NotifImportCreateResponse
import uk.co.prisom.directbanking.data.remote.dto.NotifImportListResponse
import uk.co.prisom.directbanking.data.remote.dto.NotifImportPatchRequest
import uk.co.prisom.directbanking.data.remote.dto.NotifImportPatchResponse
import uk.co.prisom.directbanking.data.remote.dto.NotifImportRequest
import uk.co.prisom.directbanking.data.remote.dto.RefreshRequest
import uk.co.prisom.directbanking.data.remote.dto.TokenResponse

/** Retrofit binding for the Direct Banking mobile API (/api/mobile/v1). */
interface MobileApi {
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

    @POST("api/mobile/v1/notification-imports")
    suspend fun createImport(@Body body: NotifImportRequest): NotifImportCreateResponse

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
