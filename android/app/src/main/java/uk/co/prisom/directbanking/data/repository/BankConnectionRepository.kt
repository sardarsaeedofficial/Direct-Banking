package uk.co.prisom.directbanking.data.repository

import uk.co.prisom.directbanking.data.local.db.BankConnectionCacheEntity
import uk.co.prisom.directbanking.data.local.db.BankConnectionDao
import uk.co.prisom.directbanking.data.remote.ApiClients
import uk.co.prisom.directbanking.data.remote.dto.BankConnectionDetailResponse
import uk.co.prisom.directbanking.data.remote.dto.BankConnectionDto
import uk.co.prisom.directbanking.data.remote.dto.SyncSummaryDto

/** Reads/edits Open Banking connections from the canonical backend, caching the list offline. */
class BankConnectionRepository(
    private val clients: ApiClients,
    private val dao: BankConnectionDao,
) {
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

    /** Begin a connection; returns the hosted authorization URL to open in a browser. */
    suspend fun start(): Pair<String, String> {
        val r = clients.authApi.startBankConnection()
        return r.connectionId to r.authorizationUrl
    }

    suspend fun sync(id: String): SyncSummaryDto = clients.authApi.syncBankConnection(id).summary

    suspend fun reauthorize(id: String): String = clients.authApi.reauthorizeBankConnection(id).authorizationUrl

    suspend fun disconnect(id: String): Boolean = clients.authApi.deleteBankConnection(id).revoked
}
