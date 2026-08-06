package uk.co.prisom.directbanking.notifications

import android.content.Context
import android.content.pm.PackageManager
import uk.co.prisom.directbanking.data.DiagnosticsRepository
import uk.co.prisom.directbanking.data.repository.CaptureResult
import uk.co.prisom.directbanking.data.repository.ImportRepository
import uk.co.prisom.directbanking.parsing.Redaction
import uk.co.prisom.directbanking.sync.SyncScheduler

/**
 * Background handler for captured notifications: resolves the source app label,
 * runs the import pipeline, records redacted diagnostics, kicks a sync when
 * something was queued, and posts a "needs review" notification.
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
        val result = importRepository.capture(raw, label)

        val resultLabel = when (result) {
            is CaptureResult.Stored -> if (result.autoQueued) "Queued for review" else "Stored"
            else -> "Rejected"
        }
        // Record only redacted text (account/card numbers masked); never raw text.
        diagnostics.recordCapture(
            pkg = raw.packageName,
            label = label,
            receivedAtMillis = raw.postTime,
            redactedTitle = raw.title?.let { Redaction.redact(it) },
            redactedText = (raw.bigText ?: raw.text)?.let { Redaction.redact(it) },
            result = resultLabel,
            reason = result.reason,
        )

        if (result is CaptureResult.Stored) {
            if (result.autoQueued) SyncScheduler.syncNow(appContext)
            if (result.reviewState != "UNRECOGNISED") {
                notifier.postReview(result.amountMinor, result.currency, result.merchant)
            }
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
