package uk.co.prisom.directbanking.data

import uk.co.prisom.directbanking.data.local.security.TokenStore

class FakeTokenStore(override val deviceId: String = "device-test") : TokenStore {
    private var access: String? = null
    private var refresh: String? = null
    private var exp: Long = 0
    private var uid: String? = null
    var cleared = false
        private set

    fun seed(access: String?, refresh: String?, userId: String? = null) {
        this.access = access; this.refresh = refresh; this.uid = userId
    }

    override fun accessToken() = access
    override fun refreshToken() = refresh
    override fun accessExpiresAtMillis() = exp
    override fun isLoggedIn() = refresh != null
    override fun userId() = uid
    override fun saveUser(id: String) { uid = id }
    override fun saveTokens(access: String, refresh: String, expiresInSeconds: Long) {
        this.access = access; this.refresh = refresh; this.exp = System.currentTimeMillis() + expiresInSeconds * 1000
    }
    override fun clear() { access = null; refresh = null; exp = 0; cleared = true }
}
