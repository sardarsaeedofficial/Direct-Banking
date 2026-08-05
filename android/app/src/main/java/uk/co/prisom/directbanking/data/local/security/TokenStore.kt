package uk.co.prisom.directbanking.data.local.security

/** Abstraction over secure credential storage so repositories are unit-testable. */
interface TokenStore {
    /** Stable per-install device id (generated once). */
    val deviceId: String

    fun accessToken(): String?
    fun refreshToken(): String?
    fun accessExpiresAtMillis(): Long
    fun isLoggedIn(): Boolean

    /** Cached user id (set at login), used for the duplicate fingerprint. */
    fun userId(): String?
    fun saveUser(id: String)

    fun saveTokens(access: String, refresh: String, expiresInSeconds: Long)
    fun clear()
}
