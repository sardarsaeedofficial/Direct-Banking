package uk.co.prisom.directbanking.data.repository

import android.os.Build
import uk.co.prisom.directbanking.data.local.security.TokenStore
import uk.co.prisom.directbanking.data.remote.ApiClients
import uk.co.prisom.directbanking.data.remote.dto.BootstrapResponse
import uk.co.prisom.directbanking.data.remote.dto.DeleteAccountRequest
import uk.co.prisom.directbanking.data.remote.dto.DeviceInfoDto
import uk.co.prisom.directbanking.data.remote.dto.LoginRequest
import uk.co.prisom.directbanking.data.remote.dto.LogoutRequest
import uk.co.prisom.directbanking.data.remote.dto.RegisterRequest
import uk.co.prisom.directbanking.data.remote.dto.UserDto

/** Owns the mobile session: login, token refresh, logout, profile/bootstrap. */
class AuthRepository(
    private val clients: ApiClients,
    private val tokenStore: TokenStore,
    private val appVersion: String,
) {
    fun isLoggedIn(): Boolean = tokenStore.isLoggedIn()
    fun cachedUserId(): String? = tokenStore.userId()

    suspend fun register(email: String, password: String, displayName: String?): Result<UserDto> = runCatching {
        val res = clients.publicApi.register(
            RegisterRequest(
                email = email.trim(),
                password = password,
                displayName = displayName?.ifBlank { null },
                device = DeviceInfoDto(deviceId = tokenStore.deviceId, model = Build.MODEL, appVersion = appVersion),
            ),
        )
        tokenStore.saveTokens(res.accessToken, res.refreshToken, res.expiresIn)
        val user = res.user ?: clients.authApi.me().user
        tokenStore.saveUser(user.id)
        user
    }

    suspend fun login(email: String, password: String, totp: String?): Result<UserDto> = runCatching {
        val res = clients.publicApi.login(
            LoginRequest(
                email = email.trim(),
                password = password,
                totp = totp?.ifBlank { null },
                device = DeviceInfoDto(deviceId = tokenStore.deviceId, model = Build.MODEL, appVersion = appVersion),
            ),
        )
        tokenStore.saveTokens(res.accessToken, res.refreshToken, res.expiresIn)
        val user = res.user ?: clients.authApi.me().user
        tokenStore.saveUser(user.id)
        user
    }

    /**
     * Explicit refresh via the shared single-flight refresher; the OkHttp
     * authenticator uses the same path on a 401, so concurrent refreshes coalesce.
     */
    suspend fun refresh(): Boolean = clients.refresher.refresh()

    suspend fun me(): UserDto = clients.authApi.me().user.also { tokenStore.saveUser(it.id) }

    suspend fun bootstrap(): BootstrapResponse = clients.authApi.bootstrap()

    suspend fun logout(allDevices: Boolean = false) {
        try {
            clients.authApi.logout(LogoutRequest(allDevices))
        } catch (_: Throwable) {
            // Best-effort; always clear local credentials regardless.
        } finally {
            tokenStore.clear()
        }
    }

    /**
     * Final release completion (§3): permanently delete the account. Unlike
     * logout(), a server failure here is NOT swallowed — the user must know
     * their account was not actually deleted, so local credentials are only
     * cleared once the server confirms deletion succeeded.
     */
    suspend fun deleteAccount(password: String): Result<Unit> = runCatching {
        clients.authApi.deleteAccount(DeleteAccountRequest(password = password))
        tokenStore.clear()
    }
}
