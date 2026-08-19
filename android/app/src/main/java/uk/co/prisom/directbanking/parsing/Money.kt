package uk.co.prisom.directbanking.parsing

/** Currency-aware amount extraction, normalising to integer minor units (pence). */
object Money {

    data class Amount(val minor: Long, val currency: String, val negative: Boolean, val raw: String)

    private val SYMBOL_CURRENCY = mapOf("£" to "GBP", "$" to "USD", "€" to "EUR")

    // Optional sign, optional leading currency (symbol or word), a number with
    // optional thousands separators and up to 2 decimals, optional trailing currency.
    private val AMOUNT = Regex(
        """(-)?\s*(GBP|USD|EUR|£|\$|€)?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)\s*(GBP|USD|EUR|£|\$|€)?""",
        RegexOption.IGNORE_CASE,
    )

    /** The first token in [text] that carries an explicit currency signal. */
    fun firstAmount(text: String): Amount? {
        for (m in AMOUNT.findAll(text)) {
            val sign = m.groupValues[1] == "-"
            val lead = m.groupValues[2]
            val num = m.groupValues[3]
            val trail = m.groupValues[4]
            val cur = normaliseCurrency(lead) ?: normaliseCurrency(trail) ?: continue // require a currency signal
            val minor = toMinor(num) ?: continue
            if (minor == 0L) continue
            return Amount(minor, cur, sign, m.value.trim())
        }
        return null
    }

    /** How many distinct currency-signalled amounts appear in [text] — for
     *  diagnostics only (a notification with several monetary values, e.g. a
     *  transaction amount plus an "available to spend" balance, is exactly
     *  the shape that used to fail silently — see CapitalOneParser). Never
     *  used to change parsing behaviour. */
    fun countAmounts(text: String): Int = AMOUNT.findAll(text).count { m ->
        val lead = m.groupValues[2]
        val trail = m.groupValues[4]
        val cur = normaliseCurrency(lead) ?: normaliseCurrency(trail)
        cur != null && (toMinor(m.groupValues[3]) ?: 0L) > 0L
    }

    private fun normaliseCurrency(token: String): String? {
        if (token.isBlank()) return null
        SYMBOL_CURRENCY[token]?.let { return it }
        val up = token.uppercase()
        return if (up in setOf("GBP", "USD", "EUR")) up else null
    }

    /** "1,234.56" -> 123456 ; "12" -> 1200 ; "12.4" -> 1240. */
    fun toMinor(number: String): Long? {
        val cleaned = number.replace(",", "").trim()
        if (cleaned.isEmpty()) return null
        val parts = cleaned.split(".")
        val whole = parts[0].toLongOrNull() ?: return null
        val frac = if (parts.size > 1) parts[1].padEnd(2, '0').take(2).toLongOrNull() ?: return null else 0L
        return whole * 100 + frac
    }

    /** Format minor units for display, e.g. 1245 -> "£12.45". */
    fun format(minor: Long, currency: String = "GBP"): String {
        val symbol = SYMBOL_CURRENCY.entries.firstOrNull { it.value == currency }?.key ?: ""
        val sign = if (minor < 0) "-" else ""
        val abs = kotlin.math.abs(minor)
        return "$sign$symbol${abs / 100}.${(abs % 100).toString().padStart(2, '0')}"
    }
}
