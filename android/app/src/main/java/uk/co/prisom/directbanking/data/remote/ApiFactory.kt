package uk.co.prisom.directbanking.data.remote

import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import uk.co.prisom.directbanking.data.local.security.TokenStore
import java.util.concurrent.TimeUnit

/** Both API bindings: [publicApi] (no auth, for login/refresh) and [authApi]. */
class ApiClients(val authApi: MobileApi, val publicApi: MobileApi)

object ApiFactory {

    val json: Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
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
        val authClient = baseClient.newBuilder()
            .addInterceptor(AuthInterceptor(tokenStore))
            .authenticator(TokenAuthenticator(tokenStore, publicApi))
            .build()
        val authApi = retrofit(baseUrl, authClient).create(MobileApi::class.java)
        return ApiClients(authApi = authApi, publicApi = publicApi)
    }

    private fun retrofit(baseUrl: String, client: OkHttpClient): Retrofit =
        Retrofit.Builder()
            .baseUrl(baseUrl)
            .client(client)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
}
