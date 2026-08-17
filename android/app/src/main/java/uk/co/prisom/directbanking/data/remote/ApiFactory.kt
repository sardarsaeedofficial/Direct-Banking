package uk.co.prisom.directbanking.data.remote

import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import uk.co.prisom.directbanking.data.local.security.TokenStore
import java.util.concurrent.TimeUnit

/** Both API bindings plus the shared single-flight refresher. */
class ApiClients(val authApi: MobileApi, val publicApi: MobileApi, val refresher: SessionRefresher)

object ApiFactory {

    val json: Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
        // The unified Activity item (Financial Event Intelligence round 2) mixes
        // Transaction and FinancialEvent rows in one response shape; several
        // fields that are always present for one kind (e.g. `direction`,
        // `provider`/`environment` on the readiness DTO) are legitimately null
        // for the other. Rather than making every shared field nullable end to
        // end, accept a JSON null for a non-nullable property that declares a
        // Kotlin default and fall back to that default instead of throwing.
        coerceInputValues = true
    }

    fun create(baseUrl: String, tokenStore: TokenStore, debug: Boolean): ApiClients {
        // BASIC logging records only method, URL and status — never headers or
        // bodies — so tokens and notification text are never logged. Off in release.
        val logging = HttpLoggingInterceptor().apply {
            level = if (debug) HttpLoggingInterceptor.Level.BASIC else HttpLoggingInterceptor.Level.NONE
        }
        val baseClient = OkHttpClient.Builder()
            .addInterceptor(logging)
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()

        val publicApi = retrofit(baseUrl, baseClient).create(MobileApi::class.java)
        val refresher = SessionRefresher(publicApi, tokenStore)
        val authClient = baseClient.newBuilder()
            .addInterceptor(AuthInterceptor(tokenStore))
            .authenticator(TokenAuthenticator(tokenStore, refresher))
            .build()
        val authApi = retrofit(baseUrl, authClient).create(MobileApi::class.java)
        return ApiClients(authApi = authApi, publicApi = publicApi, refresher = refresher)
    }

    private fun retrofit(baseUrl: String, client: OkHttpClient): Retrofit =
        Retrofit.Builder()
            .baseUrl(baseUrl)
            .client(client)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
}
