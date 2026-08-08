package uk.co.prisom.directbanking.parsing

/**
 * Best-effort extraction of transfer counterparties, reference and reason from a
 * notification. Everything is optional — a notification that lacks a field simply
 * yields null, never a fabricated value. Names are trimmed to a sensible length so
 * a run-on sentence can't be captured as a "name".
 */
object TransferParsing {

    // A capitalised personal/company name of up to four words. Kept case-sensitive
    // (the surrounding keywords are matched case-insensitively via (?i:…)) so a name
    // anchors on capitalisation rather than swallowing lowercase filler words.
    private const val NAME = "([A-Z][A-Za-z.'&-]*(?:\\s+[A-Z][A-Za-z.'&-]*){0,3})"

    // "You sent £5 to Sardar Saeed", "Payment to Sardar Saeed", "Transfer to ACME Ltd"
    private val recipientRegexes = listOf(
        Regex("""(?i:sent|paid|payment|transfer(?:red)?)\b[^A-Z]*?(?i:\bto\b)\s+$NAME"""),
        Regex("""(?i:\bto\b)\s+$NAME"""),
    )

    // "£2 from Sardar Saeed", "Received from ACME Payroll", "Payment from ..."
    private val senderRegexes = listOf(
        Regex("""(?i:received|payment|credited|money)\b[^A-Z]*?(?i:\bfrom\b)\s+$NAME"""),
        Regex("""(?i:\bfrom\b)\s+$NAME"""),
    )

    private val referenceRegex = Regex("""(?:ref(?:erence)?|payment ref)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9 _/-]{1,40})""", RegexOption.IGNORE_CASE)
    private val reasonRegex = Regex("""(?:reason|for)\s*[:]\s*([A-Za-z0-9][A-Za-z0-9 _/-]{1,60})""", RegexOption.IGNORE_CASE)

    private fun clean(raw: String?): String? {
        val v = raw?.trim()?.trimEnd('.', ',', ':', ';')?.trim() ?: return null
        return v.takeIf { it.length in 2..60 }
    }

    /** The person/company money was sent to (for an outgoing payment). */
    fun recipient(text: String): String? {
        for (r in recipientRegexes) clean(r.find(text)?.groupValues?.getOrNull(1))?.let { return it }
        return null
    }

    /** The person/company money was received from (for an incoming payment). */
    fun sender(text: String): String? {
        for (r in senderRegexes) clean(r.find(text)?.groupValues?.getOrNull(1))?.let { return it }
        return null
    }

    fun reference(text: String): String? = clean(referenceRegex.find(text)?.groupValues?.getOrNull(1))

    fun reason(text: String): String? = clean(reasonRegex.find(text)?.groupValues?.getOrNull(1))
}
