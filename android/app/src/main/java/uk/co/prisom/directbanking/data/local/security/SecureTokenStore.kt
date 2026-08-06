package uk.co.prisom.directbanking.data.local.security

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.util.UUID

/**
 * Refresh/access credentials stored in EncryptedSharedPreferences, whose master
 * key is held in the Android Keystore (hardware-backed where available). The
 * refresh token is therefore never written in cleartext.
 */
class SecureTokenStore(context: Context) : TokenStore {

    private val prefs: SharedPreferences = run {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "directbanking_secure",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    override val deviceId: String
        get() = prefs.getString(KEY_DEVICE, null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString(KEY_DEVICE, it).apply()
        }

    override fun accessToken(): String? = prefs.getString(KEY_ACCESS, null)
    override fun refreshToken(): String? = prefs.getString(KEY_REFRESH, null)
    override fun accessExpiresAtMillis(): Long = prefs.getLong(KEY_ACCESS_EXP, 0L)
    override fun isLoggedIn(): Boolean = refreshToken() != null

    override fun userId(): String? = prefs.getString(KEY_USER, null)
    override fun saveUser(id: String) { prefs.edit().putString(KEY_USER, id).apply() }

    override fun saveTokens(access: String, refresh: String, expiresInSeconds: Long) {
        prefs.edit()
            .putString(KEY_ACCESS, access)
            .putString(KEY_REFRESH, refresh)
            .putLong(KEY_ACCESS_EXP, System.currentTimeMillis() + expiresInSeconds * 1000)
            .apply()
    }

    override fun clear() {
        // Preserve the device id; only remove credentials.
        prefs.edit().remove(KEY_ACCESS).remove(KEY_REFRESH).remove(KEY_ACCESS_EXP).apply()
    }

    private companion object {
        const val KEY_DEVICE = "device_id"
        const val KEY_USER = "user_id"
        const val KEY_ACCESS = "access_token"
        const val KEY_REFRESH = "refresh_token"
        const val KEY_ACCESS_EXP = "access_expires_at"
    }
}
