package uk.co.prisom.directbanking.data.remote

import kotlinx.coroutines.runBlocking
import okhttp3.Authenticator
import okhttp3.Request
import okhttp3.Response
import okhttp3.Route
import uk.co.prisom.directbanking.data.local.security.TokenStore
import uk.co.prisom.directbanking.data.remote.dto.RefreshRequest

/**
 * On a 401, rotates the refresh token (via the no-auth [refreshApi]) and retries
 * the original request once. A failed refresh (expired/revoked/reuse) clears the
 * session so the app returns to sign-in. Refresh tokens are never logged.
 */
class TokenAuthenticator(
    private val tokenStore: TokenStore,
    private val refreshApi: MobileApi,
) : Authenticator {

    private val lock = Any()

    override fun authenticate(route: Route?, response: Response): Request? {
        if (responseCount(response) >= 2) return null // already retried once
        val failed = response.request

        synchronized(lock) {
            val currentAccess = tokenStore.accessToken()
            val usedToken = failed.header("Authorization")?.removePrefix("Bearer ")
            // Another thread may have refreshed already — retry with the new token.
            if (currentAccess != null && currentAccess != usedToken) {
                return failed.newBuilder().header("Authorization", "Bearer $currentAccess").build()
            }
            val refresh = tokenStore.refreshToken() ?: return null
            return try {
                val tokens = runBlocking { refreshApi.refresh(RefreshRequest(refresh)) }
                tokenStore.saveTokens(tokens.accessToken, tokens.refreshToken, tokens.expiresIn)
                failed.newBuilder().header("Authorization", "Bearer ${tokens.accessToken}").build()
            } catch (t: Throwable) {
                tokenStore.clear() // refresh no longer valid → force re-login
                null
            }
        }
    }

    private fun responseCount(response: Response): Int {
        var count = 1
        var prior = response.priorResponse
        while (prior != null) {
            count++
            prior = prior.priorResponse
        }
        return count
    }
}
