package uk.co.prisom.directbanking.notifications

import android.content.Context
import android.content.pm.PackageManager
import uk.co.prisom.directbanking.data.repository.CaptureResult
import uk.co.prisom.directbanking.data.repository.ImportRepository
import uk.co.prisom.directbanking.sync.SyncScheduler

/**
 * Background handler for captured notifications: resolves the source app label,
 * runs the import pipeline, and kicks a sync when something was queued. Runs off
 * the listener callback thread (invoked from a coroutine).
 */
class CaptureCoordinator(
    context: Context,
    private val importRepository: ImportRepository,
) : NotificationCaptureSink {

    private val appContext = context.applicationContext

    override suspend fun onCaptured(raw: RawNotification) {
        val label = resolveLabel(raw.packageName)
        when (val result = importRepository.capture(raw, label)) {
            is CaptureResult.Stored -> if (result.autoQueued) SyncScheduler.syncNow(appContext)
            CaptureResult.Ignored, CaptureResult.SourceNotApproved, CaptureResult.Unparsed -> Unit
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
