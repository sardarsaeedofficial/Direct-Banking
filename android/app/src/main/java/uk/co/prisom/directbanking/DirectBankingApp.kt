package uk.co.prisom.directbanking

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import uk.co.prisom.directbanking.di.AppContainer
import uk.co.prisom.directbanking.notifications.BankNotificationListenerService
import uk.co.prisom.directbanking.notifications.CaptureCoordinator
import uk.co.prisom.directbanking.sync.SyncScheduler

/**
 * Application entry point. Builds the dependency graph, wires the notification
 * capture sink, schedules background sync, and registers the channels used for
 * Direct Banking's OWN reminders / "needs review" alerts (not notification reading).
 */
class DirectBankingApp : Application() {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        BankNotificationListenerService.sink = CaptureCoordinator(this, container.importRepository, container.notifier)
        SyncScheduler.ensurePeriodic(this)
        createChannels()
    }

    private fun createChannels() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val review = NotificationChannel(
            CHANNEL_REVIEW,
            getString(R.string.app_name) + " — review",
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply { description = "Prompts to review detected transactions" }
        val reminders = NotificationChannel(
            CHANNEL_REMINDERS,
            getString(R.string.app_name) + " — reminders",
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply { description = "Direct debit and payment reminders" }
        manager.createNotificationChannels(listOf(review, reminders))
    }

    companion object {
        const val CHANNEL_REVIEW = "review_imports"
        const val CHANNEL_REMINDERS = "reminders"
    }
}
