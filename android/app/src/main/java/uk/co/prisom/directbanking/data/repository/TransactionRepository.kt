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
     * The Activity tab's real feed: the unified endpoint that also surfaces
     * non-posted FinancialEvents (upcoming bills, pending holds, declined/
     * failed attempts) alongside posted Transactions, deduplicated server-side
     * (round-2 §4). `lifecycle` is the compact selector (§3) — null/"all" means
     * every lifecycle, mixed and sorted together.
     */
    suspend fun activity(lifecycle: String? = null, limit: Int = 200, accountId: String? = null): List<TransactionSummary> =
        clients.authApi.activity(accountId = accountId, lifecycle = lifecycle, limit = limit).items.map { it.toSummary() }

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

// The plain /transactions endpoint predates lifecycle tracking, so its rows
// never carry a `lifecycle` value — derive the same vocabulary the server's
// lifecycleForTransaction() uses, so downstream rendering code has exactly
// one field to read regardless of which endpoint the row came from.
// `internal` (not `private`) purely so the DTO->domain mapping is directly
// unit-testable, the same way the rest of this codebase's mapping/business
// logic is (see TransactionMappingTest.kt).
internal fun TransactionItemDto.derivedLifecycle(): String = lifecycle ?: when {
    status == "REFUNDED" -> "REFUNDED"
    status == "CANCELLED" -> "CANCELLED"
    status == "PENDING" -> "PENDING"
    transactionType == "REFUND" -> "REFUNDED"
    else -> "COMPLETED"
}

internal fun TransactionItemDto.toSummary(): TransactionSummary {
    val lc = derivedLifecycle()
    return TransactionSummary(
        id = id,
        amountMinor = amountMinor,
        direction = direction,
        currency = currency,
        description = displayName ?: description ?: merchantName ?: merchant?.displayName ?: "Transaction",
        merchant = merchantName ?: merchant?.displayName ?: displayName,
        category = category?.name,
        account = account?.nickname,
        bookedAt = bookedAt ?: occurredAt,
        // A FinancialEvent row has no server-side `status` field at all (it's
        // never a ledger row), so the DTO decodes it to its unrelated default —
        // use the real lifecycle there instead of that placeholder.
        status = if (kind == "FINANCIAL_EVENT") lc else status,
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
        kind = kind,
        eventKind = eventKind,
        lifecycle = lc,
        expectedAt = expectedAt,
        ledgerPosted = ledgerPosted,
        reasonCode = reasonCode,
        paymentRail = paymentRail,
    )
}
