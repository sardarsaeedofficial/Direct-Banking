package uk.co.prisom.directbanking.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import uk.co.prisom.directbanking.DirectBankingApp
import uk.co.prisom.directbanking.data.repository.SyncRepository

/** Drains the pending-sync queue with WorkManager's retry/backoff. */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val container = (applicationContext as DirectBankingApp).container
        return when (container.syncRepository.processPending()) {
            SyncRepository.Outcome.RETRY -> Result.retry()
            SyncRepository.Outcome.DONE, SyncRepository.Outcome.IDLE -> Result.success()
        }
    }
}
