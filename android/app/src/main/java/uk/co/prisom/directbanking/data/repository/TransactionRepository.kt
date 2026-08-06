package uk.co.prisom.directbanking.data.repository

import uk.co.prisom.directbanking.data.remote.ApiClients
import uk.co.prisom.directbanking.domain.TransactionSummary

/** Reads existing Direct Banking transactions (not Android-only records). */
class TransactionRepository(private val clients: ApiClients) {

    suspend fun recent(limit: Int = 50, accountId: String? = null): List<TransactionSummary> =
        clients.authApi.listTransactions(limit, accountId).items.map { dto ->
            TransactionSummary(
                id = dto.id,
                amountMinor = dto.amountMinor,
                direction = dto.direction,
                currency = dto.currency,
                description = dto.description ?: dto.merchant?.displayName ?: "Transaction",
                merchant = dto.merchant?.displayName,
                category = dto.category?.name,
                account = dto.account?.nickname,
                bookedAt = dto.bookedAt,
                status = dto.status,
            )
        }
}
