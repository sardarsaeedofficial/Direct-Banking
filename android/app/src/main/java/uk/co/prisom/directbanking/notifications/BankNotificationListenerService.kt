package uk.co.prisom.directbanking.notifications

import android.app.Notification
import android.content.ComponentName
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import uk.co.prisom.directbanking.BuildConfig
import uk.co.prisom.directbanking.data.DiagnosticsRepository

/** Raw, minimally-extracted notification handed off the callback thread immediately. */
data class RawNotification(
    val packageName: String,
    val postTime: Long,
    val key: String?,
    val category: String?,
    val title: String?,
    val text: String?,
    val bigText: String?,
    val textLines: List<String>,
    val subText: String?,
)

/** Sink that receives raw captures on a background dispatcher. Wired at app start. */
fun interface NotificationCaptureSink {
    suspend fun onCaptured(raw: RawNotification)
}

/**
 * Observes notifications from user-approved financial apps. Callbacks are
 * delivered on the main thread, so we extract the small set of allowed extras
 * and immediately hand off to a background coroutine — no parsing, database or
 * network work happens on the callback thread.
 */
class BankNotificationListenerService : NotificationListenerService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onListenerConnected() {
        super.onListenerConnected()
        instance = this
        diagnostics?.setConnected(true)
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        diagnostics?.setConnected(false)
        instance = null
        // Some OEMs (notably Samsung) drop the listener binding; ask to rebind.
        runCatching { requestRebind(ComponentName(this, BankNotificationListenerService::class.java)) }
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val sbnLocal = sbn ?: return
        val raw = extract(sbnLocal) ?: return
        // Hand off immediately; do not touch DB/network/parsing here.
        scope.launch { sink?.onCaptured(raw) }
    }

    /**
     * User-initiated scan of notifications currently visible in the shade. Only
     * runs on explicit action (never silent historical scanning). Each item goes
     * through the same pipeline and is deduplicated by fingerprint.
     */
    fun scanActiveNotifications() {
        val active = runCatching { activeNotifications }.getOrNull() ?: return
        for (sbn in active) {
            val raw = extract(sbn) ?: continue
            scope.launch { sink?.onCaptured(raw) }
        }
    }

    private fun extract(sbn: StatusBarNotification): RawNotification? {
        val extras = sbn.notification?.extras ?: return null
        fun str(key: String) = extras.getCharSequence(key)?.toString()?.takeIf { it.isNotBlank() }
        val lines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
            ?.mapNotNull { it?.toString()?.takeIf(String::isNotBlank) }
            ?: emptyList()
        return RawNotification(
            packageName = sbn.packageName,
            postTime = sbn.postTime,
            key = runCatching { sbn.key }.getOrNull(),
            category = sbn.notification?.category,
            title = str(Notification.EXTRA_TITLE),
            text = str(Notification.EXTRA_TEXT),
            bigText = str(Notification.EXTRA_BIG_TEXT),
            textLines = lines,
            subText = str(Notification.EXTRA_SUB_TEXT),
        ).also {
            // Never log full notification text in release builds.
            if (BuildConfig.DEBUG) {
                android.util.Log.d(TAG, "captured from ${it.packageName} (title len=${it.title?.length ?: 0})")
            }
        }
    }

    companion object {
        private const val TAG = "BankNotifListener"

        /** Pluggable background sink (set from the application graph). */
        @Volatile
        var sink: NotificationCaptureSink? = null

        /** Diagnostics sink (set from the application graph). */
        @Volatile
        var diagnostics: DiagnosticsRepository? = null

        @Volatile
        private var instance: BankNotificationListenerService? = null

        /** True when the system currently has our listener bound. */
        val isConnected: Boolean get() = instance != null

        /** Trigger a user-initiated scan of currently visible notifications. */
        fun requestScan(): Boolean {
            val svc = instance ?: return false
            svc.scanActiveNotifications()
            return true
        }
    }
}
