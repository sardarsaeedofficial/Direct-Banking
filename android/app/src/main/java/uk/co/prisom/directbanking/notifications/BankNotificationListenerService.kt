package uk.co.prisom.directbanking.notifications

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import uk.co.prisom.directbanking.BuildConfig

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

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val sbnLocal = sbn ?: return
        val raw = extract(sbnLocal) ?: return
        // Hand off immediately; do not touch DB/network/parsing here.
        scope.launch { sink?.onCaptured(raw) }
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
    }
}
