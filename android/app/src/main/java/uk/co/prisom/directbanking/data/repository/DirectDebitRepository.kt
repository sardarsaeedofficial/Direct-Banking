package uk.co.prisom.directbanking.data.repository

import uk.co.prisom.directbanking.data.local.db.UpcomingDao
import uk.co.prisom.directbanking.data.local.db.UpcomingPaymentEntity
import uk.co.prisom.directbanking.data.remote.ApiClients
import uk.co.prisom.directbanking.data.remote.dto.DdUpdateRequest
import uk.co.prisom.directbanking.data.remote.dto.DirectDebitDetailResponse
import uk.co.prisom.directbanking.data.remote.dto.DdHistoryItemDto
import uk.co.prisom.directbanking.data.remote.dto.DirectDebitMandateDto
import uk.co.prisom.directbanking.data.remote.dto.UpcomingPaymentDto

/**
 * Reads and edits Direct Debit mandates from the canonical backend, and keeps a
 * small offline cache of upcoming payments for the Home screen.
 */
class DirectDebitRepository(
    private val clients: ApiClients,
    private val upcomingDao: UpcomingDao,
) {
    suspend fun list(status: String? = null, search: String? = null, sort: String? = null): List<DirectDebitMandateDto> =
        clients.authApi.listDirectDebits(status = status, search = search, sort = sort).items

    suspend fun detail(id: String): DirectDebitDetailResponse = clients.authApi.directDebit(id)

    suspend fun history(id: String): List<DdHistoryItemDto> = clients.authApi.directDebitHistory(id).items

    suspend fun update(id: String, body: DdUpdateRequest): DirectDebitMandateDto =
        clients.authApi.updateDirectDebit(id, body).mandate

    /** Fetch upcoming payments and refresh the offline cache write-through. */
    suspend fun upcoming(days: Int = 7): List<UpcomingPaymentDto> {
        val items = clients.authApi.upcomingPayments(days).items
        val now = System.currentTimeMillis()
        upcomingDao.clear()
        upcomingDao.upsertAll(
            items.map { UpcomingPaymentEntity(it.mandateId, it.companyName, it.account, it.expectedDate, it.expectedAmountMinor, now) },
        )
        return items
    }

    /** Offline fallback: last-cached upcoming payments. */
    suspend fun cachedUpcoming(): List<UpcomingPaymentDto> =
        upcomingDao.all().map { UpcomingPaymentDto(it.mandateId, it.companyName, it.account, expectedDate = it.expectedDate, expectedAmountMinor = it.expectedAmountMinor) }
}
