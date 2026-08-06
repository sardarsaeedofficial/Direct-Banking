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
    private val INCOME_WORDS = listOf(
        "received", "credited", "credit", "deposit", "deposited", "salary", "cashback",
        "interest", "paid in", "money in", "top up", "topped up", "added money", "you got",
    )
    private val EXPENSE_WORDS = listOf(
        "you paid", "payment to", "payment of", "card payment", "contactless", "purchase",
        "spent", "withdrawal", "withdrew", "cash withdrawal", "direct debit", "debited",
        "debit", "charged", "transfer to",
    )

    // "£50 from Sardar" (money received) — an amount immediately followed by "from".
    private val AMOUNT_FROM = Regex("""(£|gbp|\d)[\d.,]*\s+from\s+\p{L}""", RegexOption.IGNORE_CASE)
    // "You sent … to X" / "Sent £5 to X" (money out). NOT "Sent from <app>" (a rail).
    private val SENT_TO = Regex("""\bsent\b(?![^.]*\bfrom\b)[^.]*\bto\b""")

    /**
     * Returns the detected direction, or null if no clear signal. Distinguishes
     * outgoing "you sent … to" from incoming "£X from <name>", and treats
     * "Sent from <app>" (payment-rail text) as noise rather than an outgoing signal.
     */
    fun detect(text: String): TransactionDirection? {
        val t = text.lowercase()
        if (t.contains("refund")) return TransactionDirection.INCOME

        val youSent = t.contains("you sent") || SENT_TO.containsMatchIn(t)
        val incomeFrom = AMOUNT_FROM.containsMatchIn(t) || t.contains("received from") || t.contains("transfer from")

        val income = INCOME_WORDS.any { t.contains(it) } || incomeFrom
        val expense = EXPENSE_WORDS.any { t.contains(it) } || youSent

        return when {
            expense && !income -> TransactionDirection.EXPENSE
            income && !expense -> TransactionDirection.INCOME
            youSent -> TransactionDirection.EXPENSE // explicit "you sent … to" wins as outgoing
            incomeFrom -> TransactionDirection.INCOME // else "amount from <name>" wins as incoming
            expense -> TransactionDirection.EXPENSE // both, otherwise: default to spend
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
