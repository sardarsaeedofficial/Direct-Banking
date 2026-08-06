package uk.co.prisom.directbanking.data.remote

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import uk.co.prisom.directbanking.data.local.security.TokenStore
import uk.co.prisom.directbanking.data.remote.dto.RefreshRequest

/**
 * Single-flight access-token refresh: concurrent callers that all see a 401
 * coalesce into ONE network refresh and share its result. A failed refresh
 * (expired/revoked/reused token) clears the session, forcing sign-out.
 */
class SessionRefresher(
    private val publicApi: MobileApi,
    private val tokenStore: TokenStore,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    private val mutex = Mutex()
    private var inFlight: Deferred<Boolean>? = null

    suspend fun refresh(): Boolean {
        val deferred = mutex.withLock {
            val current = inFlight
            if (current != null && current.isActive) {
                current
            } else {
                scope.async { doRefresh() }.also { inFlight = it }
            }
        }
        return deferred.await()
    }

    /** Blocking entry point for the OkHttp authenticator (called off the main thread). */
    fun refreshBlocking(): Boolean = runBlocking { refresh() }

    private suspend fun doRefresh(): Boolean {
        val refreshToken = tokenStore.refreshToken() ?: return false
        return try {
            val tokens = publicApi.refresh(RefreshRequest(refreshToken))
            tokenStore.saveTokens(tokens.accessToken, tokens.refreshToken, tokens.expiresIn)
            true
        } catch (t: Throwable) {
            tokenStore.clear() // refresh no longer valid → force re-login
            false
        }
    }
}
