package uk.co.prisom.directbanking.parsing

import java.time.Instant

/** Matches the server's TxnDirection. */
enum class TransactionDirection { INCOME, EXPENSE }

/**
 * Result of parsing a single notification. Monetary values are normalised to
 * integer minor units (pence). [redactedSourceText] never contains raw account
 * numbers or full card numbers.
 */
data class ParsedTransactionCandidate(
    val direction: TransactionDirection,
    val amountMinor: Long,
    val currency: String,
    val merchant: String?,
    val accountHint: String?,
    val occurredAt: Instant,
    val sourcePackage: String,
    val confidence: Double,
    val redactedSourceText: String,
)
