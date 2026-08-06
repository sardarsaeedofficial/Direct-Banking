package uk.co.prisom.directbanking.data.local

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore("directbanking_prefs")

/** Small, non-sensitive app preferences (consent flags, last-sync time). */
class AppPreferences(private val context: Context) {

    val disclosureAccepted: Flow<Boolean> = context.dataStore.data.map { it[KEY_DISCLOSURE] ?: false }
    val lastSyncAtMillis: Flow<Long> = context.dataStore.data.map { it[KEY_LAST_SYNC] ?: 0L }

    suspend fun setDisclosureAccepted(accepted: Boolean) {
        context.dataStore.edit { it[KEY_DISCLOSURE] = accepted }
    }

    suspend fun setLastSyncNow(now: Long = System.currentTimeMillis()) {
        context.dataStore.edit { it[KEY_LAST_SYNC] = now }
    }

    private companion object {
        val KEY_DISCLOSURE = booleanPreferencesKey("disclosure_accepted")
        val KEY_LAST_SYNC = androidx.datastore.preferences.core.longPreferencesKey("last_sync_at")
    }
}
