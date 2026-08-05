package uk.co.prisom.directbanking.parsing

import java.time.Instant

/** Normalised parser input assembled from the allowed notification extras. */
data class NotificationInput(
    val sourcePackage: String,
    val postTime: Long,
    val title: String? = null,
    val text: String? = null,
    val bigText: String? = null,
    val textLines: List<String> = emptyList(),
    val subText: String? = null,
) {
    /** All readable text joined for scanning (big text preferred, then lines). */
    val combinedText: String =
        (listOfNotNull(title, bigText ?: text, subText) + textLines)
            .filter { it.isNotBlank() }
            .joinToString(" ")
            .replace(Regex("\\s+"), " ")
            .trim()

    val occurredAt: Instant get() = Instant.ofEpochMilli(postTime)
}

/** A parser that may recognise a financial notification. */
interface NotificationParser {
    fun parse(input: NotificationInput): ParsedTransactionCandidate?
}

/** Keyword-based direction detection shared by the generic parser and adapters. */
object DirectionRules {
    private val INCOME = listOf(
        "refund", "refunded", "credited", "credit", "received", "deposit", "deposited",
        "salary", "paid in", "cashback", "interest", "received from",
    )
    private val EXPENSE = listOf(
        "debited", "debit", "card payment", "contactless", "payment to", "payment of",
        "purchase", "spent", "withdrawal", "withdrew", "cash withdrawal", "direct debit",
        "transfer to", "sent", "charged", "you paid",
    )

    /** Returns the detected direction, or null if no clear signal. */
    fun detect(text: String): TransactionDirection? {
        val t = text.lowercase()
        // Refunds are income even if the text also says "payment".
        if (t.contains("refund")) return TransactionDirection.INCOME
        if (t.contains("transfer to") || t.contains("sent to")) return TransactionDirection.EXPENSE
        if (t.contains("received from") || t.contains("transfer from")) return TransactionDirection.INCOME
        val income = INCOME.any { t.contains(it) }
        val expense = EXPENSE.any { t.contains(it) }
        return when {
            expense && !income -> TransactionDirection.EXPENSE
            income && !expense -> TransactionDirection.INCOME
            expense -> TransactionDirection.EXPENSE // both present: default to spend
            income -> TransactionDirection.INCOME
            else -> null
        }
    }
}

/** Best-effort merchant extraction for the generic parser. */
object MerchantRules {
    private val AFTER_PREPOSITION = Regex(
        """(?:at|to|from)\s+([A-Z0-9][\w&'’.\- ]{1,39})""",
    )
    private val TRAILING_JUNK = Regex("""[\s.,;:]+$""")

    fun extract(text: String): String? {
        val m = AFTER_PREPOSITION.find(text) ?: return null
        val raw = m.groupValues[1].replace(TRAILING_JUNK, "").trim()
        // Stop at obvious sentence continuations.
        val cleaned = raw.substringBefore(" on ").substringBefore(" using ").trim()
        return cleaned.ifBlank { null }
    }
}
