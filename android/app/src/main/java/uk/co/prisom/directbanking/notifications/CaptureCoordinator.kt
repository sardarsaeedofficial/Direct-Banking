package uk.co.prisom.directbanking.notifications

import android.content.Context
import android.content.pm.PackageManager
import uk.co.prisom.directbanking.data.DiagnosticsRepository
import uk.co.prisom.directbanking.data.RefreshSignal
import uk.co.prisom.directbanking.data.repository.ImportOutcome
import uk.co.prisom.directbanking.data.repository.ImportRepository
import uk.co.prisom.directbanking.parsing.Redaction
import uk.co.prisom.directbanking.sync.SyncScheduler

/**
 * Background handler for captured notifications: resolves the source app label,
 * runs the import pipeline, records redacted diagnostics, and — for automatic
 * imports — posts a "recorded" notification and refreshes the dashboard. Runs
 * off the listener callback thread.
 */
class CaptureCoordinator(
    context: Context,
    private val importRepository: ImportRepository,
    private val notifier: AppNotifier,
    private val diagnostics: DiagnosticsRepository,
) : NotificationCaptureSink {

    private val appContext = context.applicationContext

    override suspend fun onCaptured(raw: RawNotification) {
        val label = resolveLabel(raw.packageName)
        val o = importRepository.capture(raw, label)

        diagnostics.recordCapture(
            pkg = raw.packageName,
            label = o.sourceName ?: label,
            receivedAtMillis = raw.postTime,
            redactedTitle = raw.title?.let { Redaction.redact(it) },
            redactedText = (raw.bigText ?: raw.text)?.let { Redaction.redact(it) },
            sourceTrustedOrApproved = o.trustedOrApproved,
            autoImportEnabled = o.autoImportEnabled,
            linkedAccountId = o.linkedAccountId,
            parsedAmountMinor = o.amountMinor,
            parsedDirection = o.direction,
            parsedCurrency = o.currency,
            confidence = o.confidence,
            importResult = o.outcome.name,
            transactionId = o.transactionId,
            failureReason = o.reason,
        )

        when (o.outcome) {
            ImportOutcome.AUTO_IMPORTED -> {
                notifier.postRecorded(o.amountMinor ?: 0, o.currency ?: "GBP", o.direction ?: "EXPENSE", o.sourceName ?: label, o.transactionId)
                RefreshSignal.trigger()
                SyncScheduler.syncNow(appContext)
            }
            ImportOutcome.REVIEW_REQUIRED -> {
                SyncScheduler.syncNow(appContext)
                notifier.postReview(o.amountMinor ?: 0, o.currency ?: "GBP", o.merchant)
            }
            ImportOutcome.SYNC_FAILED -> SyncScheduler.syncNow(appContext) // retry the queued auto op
            ImportOutcome.SETUP_REQUIRED, ImportOutcome.DUPLICATE, ImportOutcome.REJECTED -> Unit
        }
    }

    /** Resolves a human label for the posting app without QUERY_ALL_PACKAGES. */
    private fun resolveLabel(packageName: String): String = try {
        val pm = appContext.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
    } catch (_: PackageManager.NameNotFoundException) {
        packageName
    }
}
