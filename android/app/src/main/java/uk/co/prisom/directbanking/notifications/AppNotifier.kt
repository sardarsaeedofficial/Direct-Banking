package uk.co.prisom.directbanking.notifications

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import uk.co.prisom.directbanking.DirectBankingApp
import uk.co.prisom.directbanking.parsing.Money

/** Posts Direct Banking's own review/reminder notifications (needs POST_NOTIFICATIONS on 33+). */
class AppNotifier(private val context: Context) {

    // Guarded by canPost(); notify() is wrapped in runCatching as a further safety net.
    @SuppressLint("MissingPermission")
    fun postReview(amountMinor: Long, currency: String, merchant: String?) {
        if (!canPost()) return
        val amount = Money.format(amountMinor, currency)
        val where = merchant?.let { " at $it" } ?: ""
        val notification = NotificationCompat.Builder(context, DirectBankingApp.CHANNEL_REVIEW)
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentTitle("Transaction detected — review $amount")
            .setContentText("Review$where before it's imported")
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .build()
        runCatching { NotificationManagerCompat.from(context).notify(REVIEW_ID, notification) }
    }

    @SuppressLint("MissingPermission")
    fun postReviewCount(count: Int) {
        if (!canPost() || count <= 0) return
        val notification = NotificationCompat.Builder(context, DirectBankingApp.CHANNEL_REVIEW)
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentTitle("$count transaction imports need review")
            .setAutoCancel(true)
            .build()
        runCatching { NotificationManagerCompat.from(context).notify(REVIEW_ID, notification) }
    }

    private fun canPost(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private companion object {
        const val REVIEW_ID = 1001
    }
}
