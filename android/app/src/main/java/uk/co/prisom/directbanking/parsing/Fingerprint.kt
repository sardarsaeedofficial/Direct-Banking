package uk.co.prisom.directbanking.parsing

import java.security.MessageDigest

/**
 * Stable duplicate fingerprint. Built from normalised values so a reposted or
 * updated notification maps to the same fingerprint; the server enforces
 * uniqueness on it to prevent duplicate transactions.
 */
object Fingerprint {

    /** Time bucket so near-identical reposts within the window collapse together. */
    const val WINDOW_MILLIS = 120_000L

    fun normaliseMerchant(merchant: String?): String =
        merchant?.lowercase()?.replace(Regex("[^a-z0-9]"), "") ?: ""

    fun compute(
        userId: String,
        deviceId: String,
        sourcePackage: String,
        amountMinor: Long,
        direction: TransactionDirection,
        merchant: String?,
        occurredAtEpochMillis: Long,
        windowMillis: Long = WINDOW_MILLIS,
    ): String {
        val bucket = occurredAtEpochMillis / windowMillis
        val raw = listOf(
            userId,
            deviceId,
            sourcePackage,
            amountMinor.toString(),
            direction.name,
            normaliseMerchant(merchant),
            bucket.toString(),
        ).joinToString("|")
        return sha256Hex(raw)
    }

    private fun sha256Hex(input: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }
}
