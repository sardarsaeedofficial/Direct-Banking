package uk.co.prisom.directbanking.data.repository

import uk.co.prisom.directbanking.data.local.db.BankConnectionCacheEntity
import uk.co.prisom.directbanking.data.local.db.BankConnectionDao
import uk.co.prisom.directbanking.data.remote.ApiClients
import uk.co.prisom.directbanking.data.remote.dto.BankConnectionDetailResponse
import uk.co.prisom.directbanking.data.remote.dto.BankConnectionDto
import uk.co.prisom.directbanking.data.remote.dto.BankConnectionsReadiness
import uk.co.prisom.directbanking.data.remote.dto.CompleteConnectionRequest
import uk.co.prisom.directbanking.data.remote.dto.StartConnectionResponse
import uk.co.prisom.directbanking.data.remote.dto.SyncSummaryDto

/** Reads/edits Open Banking connections from the canonical backend, caching the list offline. */
class BankConnectionRepository(
    private val clients: ApiClients,
    private val dao: BankConnectionDao,
) {
    /** Safe, non-secret readiness check — call before offering "Connect a bank"
     *  so the UI can show a clear reason (disabled / not configured) instead
     *  of only discovering a problem after start() fails. */
    suspend fun readiness(): BankConnectionsReadiness = clients.authApi.bankConnectionsReadiness()

    suspend fun list(): List<BankConnectionDto> {
        val items = clients.authApi.listBankConnections().items
        val now = System.currentTimeMillis()
        dao.clear()
        dao.upsertAll(items.map { BankConnectionCacheEntity(it.id, it.provider, it.status, it.institutionName, it.lastSuccessfulSyncAt, now) })
        return items
    }

    /** Offline fallback: last-cached connections. */
    suspend fun cached(): List<BankConnectionDto> =
        dao.all().map { BankConnectionDto(it.id, it.provider, it.status, it.institutionName, lastSuccessfulSyncAt = it.lastSuccessfulSyncAt) }

    suspend fun detail(id: String): BankConnectionDetailResponse = clients.authApi.bankConnection(id)

    /** Begin a connection; the payload says how to complete it (hosted URL or link token). */
    suspend fun start(): StartConnectionResponse = clients.authApi.startBankConnection()

    /** Complete a link-token (Plaid) connection with the public token from the client SDK. */
    suspend fun complete(id: String, publicToken: String): Boolean =
        clients.authApi.completeBankConnection(id, CompleteConnectionRequest(publicToken)).ok

    suspend fun sync(id: String): SyncSummaryDto = clients.authApi.syncBankConnection(id).summary

    /** Re-authorize; returns the payload (hosted URL or link token) to relaunch the journey. */
    suspend fun reauthorize(id: String): StartConnectionResponse = clients.authApi.reauthorizeBankConnection(id).let {
        StartConnectionResponse(it.connectionId, it.provider, it.mode, it.authorizationUrl, it.linkToken)
    }

    suspend fun disconnect(id: String): Boolean = clients.authApi.deleteBankConnection(id).revoked
}
