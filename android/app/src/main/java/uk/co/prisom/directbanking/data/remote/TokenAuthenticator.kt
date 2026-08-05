package uk.co.prisom.directbanking.data.remote

import okhttp3.Authenticator
import okhttp3.Request
import okhttp3.Response
import okhttp3.Route
import uk.co.prisom.directbanking.data.local.security.TokenStore

/**
 * On a 401, performs a single-flight refresh (via [SessionRefresher]) and retries
 * the original request once. A failed refresh clears the session so the app
 * returns to sign-in. Refresh tokens are never logged.
 */
class TokenAuthenticator(
    private val tokenStore: TokenStore,
    private val refresher: SessionRefresher,
) : Authenticator {

    override fun authenticate(route: Route?, response: Response): Request? {
        if (responseCount(response) >= 2) return null // already retried once
        val failed = response.request
        val usedToken = failed.header("Authorization")?.removePrefix("Bearer ")

        // Another request may have already refreshed while this one was in flight.
        val current = tokenStore.accessToken()
        if (current != null && current != usedToken) {
            return failed.newBuilder().header("Authorization", "Bearer $current").build()
        }

        val refreshed = refresher.refreshBlocking()
        if (!refreshed) return null // session cleared → force re-login
        val newAccess = tokenStore.accessToken() ?: return null
        return failed.newBuilder().header("Authorization", "Bearer $newAccess").build()
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
