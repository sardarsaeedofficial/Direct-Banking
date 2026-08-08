package uk.co.prisom.directbanking.data.repository

import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import retrofit2.HttpException
import uk.co.prisom.directbanking.data.RefreshSignal
import uk.co.prisom.directbanking.data.local.db.ImportDao
import uk.co.prisom.directbanking.data.local.db.SyncDao
import uk.co.prisom.directbanking.data.remote.MobileApi
import uk.co.prisom.directbanking.data.remote.dto.NotifAutoImportRequest
import uk.co.prisom.directbanking.data.remote.dto.NotifImportPatchRequest
import uk.co.prisom.directbanking.data.remote.dto.NotifImportRequest

/**
 * Replays queued operations against the backend. Every upload is idempotent:
 * CREATE relies on the server's per-user fingerprint uniqueness, APPROVE treats
 * 409 (already approved) as success, DELETE treats 404 as success, and AUTO_IMPORT
 * is idempotent server-side (retries never move the balance twice).
 */
class SyncRepository(
    private val api: MobileApi,
    private val importDao: ImportDao,
    private val syncDao: SyncDao,
    private val json: Json,
    private val onAutoImported: (amountMinor: Long, currency: String, direction: String, sourceName: String, transactionId: String?) -> Unit = { _, _, _, _, _ -> },
) {
    enum class Outcome { IDLE, DONE, RETRY }

    fun observePendingCount(): Flow<Int> = syncDao.observeCount()

    suspend fun processPending(): Outcome {
        val ops = syncDao.all()
        if (ops.isEmpty()) return Outcome.IDLE
        var anyFailed = false
        for (op in ops) {
            try {
                when (op.type) {
                    "CREATE_IMPORT" -> {
                        val req = json.decodeFromString<NotifImportRequest>(op.payloadJson)
                        val res = api.createImport(req)
                        op.fingerprint?.let { importDao.setStatus(it, "SYNCED", res.import.id) }
                        syncDao.delete(op)
                    }
                    "APPROVE" -> {
                        val remoteId = op.fingerprint?.let { importDao.byFingerprint(it)?.remoteId }
                        if (remoteId == null) {
                            // CREATE hasn't landed yet; retry after it does (FIFO).
                            anyFailed = true
                            syncDao.markFailure(op.id, "awaiting import id")
                        } else {
                            val req = json.decodeFromString<NotifImportPatchRequest>(op.payloadJson)
                            api.patchImport(remoteId, req)
                            syncDao.delete(op)
                        }
                    }
                    "REJECT" -> {
                        val remoteId = op.remoteId ?: op.fingerprint?.let { importDao.byFingerprint(it)?.remoteId }
                        if (remoteId != null) api.patchImport(remoteId, NotifImportPatchRequest(action = "reject"))
                        syncDao.delete(op)
                    }
                    "DELETE" -> {
                        op.remoteId?.let { api.deleteImport(it) }
                        syncDao.delete(op)
                    }
                    "AUTO_IMPORT" -> {
                        val req = json.decodeFromString<NotifAutoImportRequest>(op.payloadJson)
                        val res = api.autoImport(req)
                        op.fingerprint?.let { importDao.setStatus(it, "AUTO_IMPORTED", res.import.id) }
                        syncDao.delete(op)
                        if (res.result == "AUTO_IMPORTED") {
                            RefreshSignal.trigger()
                            onAutoImported(req.amountMinor, req.currency, req.direction, req.title, res.transaction?.id)
                        }
                    }
                    else -> syncDao.delete(op)
                }
            } catch (e: HttpException) {
                if (e.code() == 409 || e.code() == 404) {
                    syncDao.delete(op) // already applied / already gone → idempotent success
                } else {
                    anyFailed = true
                    syncDao.markFailure(op.id, "http ${e.code()}")
                }
            } catch (e: Throwable) {
                anyFailed = true
                syncDao.markFailure(op.id, e.message?.take(120))
            }
        }
        return if (anyFailed) Outcome.RETRY else Outcome.DONE
    }
}
