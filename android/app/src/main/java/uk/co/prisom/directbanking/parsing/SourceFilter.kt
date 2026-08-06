package uk.co.prisom.directbanking.parsing

/**
 * Baseline "always ignore" policy applied before the user's allowlist. Only
 * notifications that pass this AND are on the user-approved source list are ever
 * parsed. We never process all notification text indiscriminately.
 */
object SourceFilter {

    private val ALWAYS_IGNORE_EXACT = setOf(
        "uk.co.prisom.directbanking",
        "uk.co.prisom.directbanking.debug",
        "android",
        "com.android.systemui",
    )

    private val ALWAYS_IGNORE_PREFIXES = listOf(
        // System
        "com.android.", "com.google.android.gms", "com.google.android.gsf",
        // Messaging
        "com.whatsapp", "org.telegram", "com.facebook.orca", "com.facebook.mlite",
        "com.google.android.apps.messaging", "com.android.messaging", "org.thoughtcrime.securesms",
        "com.discord", "com.snapchat", "com.instagram", "org.thunderdog",
        // Email
        "com.google.android.gm", "com.microsoft.office.outlook", "com.yahoo.mobile.client.android.mail",
        "com.fsck.k9", "ch.protonmail",
        // Authenticators / OTP
        "com.google.android.apps.authenticator2", "com.azure.authenticator",
        "com.duosecurity.duomobile", "com.authy",
    )

    private val OTP_KEYWORDS = listOf(
        "one-time", "one time passcode", "otp", "verification code", "security code",
        "2fa", "do not share", "your code is", "login code", "passcode",
    )

    fun isIgnoredPackage(packageName: String): Boolean {
        if (packageName in ALWAYS_IGNORE_EXACT) return true
        return ALWAYS_IGNORE_PREFIXES.any { packageName == it || packageName.startsWith(it) }
    }

    fun looksLikeOtp(text: String): Boolean {
        val t = text.lowercase()
        return OTP_KEYWORDS.any { t.contains(it) }
    }

    /** True only if the package is not baseline-ignored and the text is not an OTP/auth message. */
    fun passesBaseline(packageName: String, text: String): Boolean =
        !isIgnoredPackage(packageName) && !looksLikeOtp(text)
}
