package uk.co.prisom.directbanking.notifications

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.provider.Settings

/** Helpers for the notification-listener access grant (separate from POST_NOTIFICATIONS). */
object NotificationAccess {

    /** True if the user has granted notification-listener access to our service. */
    fun isEnabled(context: Context): Boolean {
        val flat = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners") ?: return false
        val ours = ComponentName(context, BankNotificationListenerService::class.java)
        return flat.split(":").any { ComponentName.unflattenFromString(it) == ours }
    }

    /** Intent that opens the system Notification access settings screen. */
    fun settingsIntent(): Intent =
        Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
}
