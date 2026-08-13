package uk.co.prisom.directbanking.data.repository

import uk.co.prisom.directbanking.data.remote.ApiClients
import uk.co.prisom.directbanking.data.remote.dto.PairRequest
import uk.co.prisom.directbanking.data.remote.dto.ReviewCentreDto
import uk.co.prisom.directbanking.data.remote.dto.UnpairRequest

/** Reconciliation Review Centre + manual transfer pairing + CSV export (Phase 5). */
class ReviewRepository(private val clients: ApiClients) {
    suspend fun centre(): ReviewCentreDto = clients.authApi.reviewCentre()
    suspend fun merge(id: String) { clients.authApi.reviewMerge(id) }
    suspend fun keepSeparate(id: String) { clients.authApi.reviewKeepSeparate(id) }
    suspend fun pair(aId: String, bId: String) { clients.authApi.pairTransfer(PairRequest(aId, bId)) }
    suspend fun unpair(id: String) { clients.authApi.unpairTransfer(UnpairRequest(id)) }

    /** Fetch the CSV export bytes (canonical financial data only). */
    suspend fun exportCsv(accountId: String? = null, type: String? = null, from: String? = null, to: String? = null): ByteArray =
        clients.authApi.exportTransactions(accountId = accountId, type = type, from = from, to = to).bytes()
}
