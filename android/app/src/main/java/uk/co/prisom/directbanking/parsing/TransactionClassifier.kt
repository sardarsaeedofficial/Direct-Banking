package uk.co.prisom.directbanking.parsing

/**
 * Recognises bank notifications that are NOT spend/receive transactions and must
 * never become a transaction (declined, reversed, verification/security, balance
 * summaries, promotional/informational messages).
 */
object TransactionClassifier {

    private val NON_TRANSACTION = listOf(
        "declined", "was declined", "payment failed", "unsuccessful",
        "reversed", "refund pending", "authorisation only", "pre-auth", "pending authorisation",
        "verification code", "security code", "one-time", "one time passcode", "otp", "passcode",
        "log in", "login", "sign in", "verify your", "confirm your identity", "do not share",
        "your balance is", "current balance", "available balance", "balance:", "statement is ready", "statement ready",
        "offer", "promotion", "promotional", "discount", "% off", "reward", "win ", "prize",
        "update your app", "new feature", "tips", "survey",
    )

    fun isNonTransaction(text: String): Boolean {
        val t = text.lowercase()
        // "cashback" / "you earned" are genuine income — don't let "reward" veto them.
        if (t.contains("cashback")) return false
        return NON_TRANSACTION.any { t.contains(it) }
    }
}
