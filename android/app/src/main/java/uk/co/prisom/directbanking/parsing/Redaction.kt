package uk.co.prisom.directbanking.parsing

/**
 * Redacts sensitive numbers from notification text. Account and card numbers are
 * masked except for the final four digits; PINs/long digit runs are masked.
 */
object Redaction {

    private val CARD_LIKE = Regex("""(?:\d[ -]?){13,19}""")
    private val DIGIT_RUN = Regex("""\d{5,}""")
    private val ACCOUNT_HINT = Regex(
        """(?:ending(?:\s+in)?|acct\.?|account|card)\D{0,6}(\d{4})\b""",
        RegexOption.IGNORE_CASE,
    )
    // Masked "ending" forms such as ••1234, xx1234, ..1234
    private val MASKED_HINT = Regex("""[*•xX.•]{2,}\s?(\d{4})\b""")

    fun redact(text: String): String {
        var out = CARD_LIKE.replace(text) { m ->
            val digits = m.value.filter(Char::isDigit)
            if (digits.length < 13) m.value else "•••• " + digits.takeLast(4)
        }
        out = DIGIT_RUN.replace(out) { m ->
            val d = m.value
            "•".repeat((d.length - 4).coerceAtLeast(0)) + d.takeLast(4)
        }
        return out.trim()
    }

    /** Last four digits of an account/card mentioned in the text, if any. */
    fun accountHint(text: String): String? {
        ACCOUNT_HINT.find(text)?.groupValues?.get(1)?.let { return it }
        MASKED_HINT.find(text)?.groupValues?.get(1)?.let { return it }
        return null
    }
}
