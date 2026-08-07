package uk.co.prisom.directbanking.notifications

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import uk.co.prisom.directbanking.DirectBankingApp
import uk.co.prisom.directbanking.MainActivity
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

    /** "£2.00 credit from Monzo recorded" with an action to open the transaction. */
    @SuppressLint("MissingPermission")
    fun postRecorded(amountMinor: Long, currency: String, direction: String, sourceName: String, transactionId: String?) {
        if (!canPost()) return
        val amount = Money.format(amountMinor, currency)
        val kind = if (direction == "INCOME") "credit" else "debit"
        val open = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("openTransactionId", transactionId)
        }
        val pending = PendingIntent.getActivity(
            context, (transactionId?.hashCode() ?: 0),
            open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, DirectBankingApp.CHANNEL_REVIEW)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle("$amount $kind from $sourceName recorded")
            .setContentText("Tap to open the transaction")
            .setContentIntent(pending)
            .addAction(0, "Open transaction", pending)
            .setAutoCancel(true)
            .build()
        runCatching { NotificationManagerCompat.from(context).notify(RECORDED_ID + (transactionId?.hashCode() ?: 0), notification) }
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
        const val RECORDED_ID = 2000
    }
}
