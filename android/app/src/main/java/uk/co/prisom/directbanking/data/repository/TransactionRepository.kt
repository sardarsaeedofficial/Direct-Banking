package uk.co.prisom.directbanking.data.repository

import uk.co.prisom.directbanking.data.remote.ApiClients
import uk.co.prisom.directbanking.data.remote.dto.TransactionItemDto
import uk.co.prisom.directbanking.data.remote.dto.TxnCorrectionRequest
import uk.co.prisom.directbanking.domain.TransactionSummary

/** Reads and corrects existing Direct Banking transactions (server is the ledger). */
class TransactionRepository(private val clients: ApiClients) {

    suspend fun recent(limit: Int = 50, accountId: String? = null): List<TransactionSummary> =
        clients.authApi.listTransactions(limit, accountId).items.map { it.toSummary() }

    /**
     * Apply a manual correction (change type, mark/undo internal transfer, edit
     * counterparties/notes, link an own-account) and return the updated row.
     */
    suspend fun correct(id: String, request: TxnCorrectionRequest): TransactionSummary =
        clients.authApi.correctTransaction(id, request).transaction.toSummary()

    /** Mark or undo "this is a transfer between my accounts". */
    suspend fun setInternalTransfer(id: String, internal: Boolean, counterpartyAccountId: String? = null): TransactionSummary =
        correct(id, TxnCorrectionRequest(markInternalTransfer = internal, counterpartyAccountId = counterpartyAccountId))

    /** Change the canonical transaction type. */
    suspend fun setType(id: String, type: String): TransactionSummary =
        correct(id, TxnCorrectionRequest(transactionType = type))
}

private fun TransactionItemDto.toSummary() = TransactionSummary(
    id = id,
    amountMinor = amountMinor,
    direction = direction,
    currency = currency,
    description = description ?: merchantName ?: merchant?.displayName ?: "Transaction",
    merchant = merchantName ?: merchant?.displayName,
    category = category?.name,
    account = account?.nickname,
    bookedAt = bookedAt,
    status = status,
    transactionType = transactionType,
    source = source,
    senderName = senderName,
    senderBankName = senderBankName,
    recipientName = recipientName,
    recipientBankName = recipientBankName,
    paymentReference = paymentReference,
    paymentReason = paymentReason,
    notes = notes,
    subcategory = subcategory,
    occurredAt = occurredAt,
    settledAt = settledAt,
    internalTransferGroupId = internalTransferGroupId,
    internalTransferConfidence = internalTransferConfidence,
)
