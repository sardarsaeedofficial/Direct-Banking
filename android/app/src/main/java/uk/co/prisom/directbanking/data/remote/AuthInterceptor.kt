package uk.co.prisom.directbanking.data.remote

import okhttp3.Interceptor
import okhttp3.Response
import uk.co.prisom.directbanking.data.local.security.TokenStore

/** Attaches the bearer access token to authenticated requests. */
class AuthInterceptor(private val tokenStore: TokenStore) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val path = request.url.encodedPath
        // Login/refresh must not carry a (possibly stale) bearer token.
        if (path.endsWith("/auth/login") || path.endsWith("/auth/refresh")) {
            return chain.proceed(request)
        }
        val token = tokenStore.accessToken()
        val authed = if (token != null) {
            request.newBuilder().header("Authorization", "Bearer $token").build()
        } else {
            request
        }
        return chain.proceed(authed)
    }
}
