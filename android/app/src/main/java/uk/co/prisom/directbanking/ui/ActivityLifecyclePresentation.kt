package uk.co.prisom.directbanking.ui

import uk.co.prisom.directbanking.domain.TransactionSummary

/**
 * Pure lifecycle-presentation logic for the Activity list/detail screens
 * (Financial Event Intelligence round 2, §1/§2). Kept separate from
 * ActivityScreen.kt's Composables — no Compose/Android types here — so it's
 * plain-JVM-testable the same way the rest of this codebase's business logic
 * is, without needing Robolectric or an instrumented test.
 */

/** How prominent/what tone a lifecycle badge should read as. Tone (colour) is
 *  never the only signal a state communicates — every non-null [LifecycleBadge]
 *  always pairs an icon and exact text with whatever tone/colour is applied. */
enum class LifecycleTone { NEUTRAL, NEGATIVE, POSITIVE }

/** Icon *kind*, not a concrete Compose ImageVector — keeps this file free of
 *  any Compose/Android dependency. ActivityScreen.kt maps this to a real icon. */
enum class LifecycleIconKind { INFO, WARNING, REFRESH }

data class LifecycleBadge(val statusText: String, val subText: String?, val icon: LifecycleIconKind, val tone: LifecycleTone)

/** Friendly noun for an UPCOMING event's headline, e.g. "Upcoming credit-card
 *  repayment" / "Upcoming Direct Debit". Falls back to a generic "payment" —
 *  never invents a more specific kind than the classifier actually reported. */
fun eventKindNoun(eventKind: String?): String = when (eventKind) {
    "CREDIT_CARD_REPAYMENT" -> "credit-card repayment"
    "DIRECT_DEBIT" -> "Direct Debit"
    "STANDING_ORDER" -> "standing order"
    "SUBSCRIPTION" -> "subscription payment"
    "CASH_WITHDRAWAL" -> "cash withdrawal"
    "BANK_TRANSFER" -> "transfer"
    else -> "payment"
}

private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/** "Expected 20 Aug" from an ISO date/date-time string; never fabricates a
 *  date the server didn't actually send. */
fun expectedDateLabel(expectedAtIso: String?): String {
    val formatted = expectedAtIso?.take(10)?.split("-")?.takeIf { it.size == 3 }?.let { p ->
        runCatching { "${p[2].toInt()} ${MONTHS[p[1].toInt() - 1]}" }.getOrNull()
    }
    return if (formatted != null) "Expected $formatted" else "Expected soon"
}

/**
 * The lifecycle-aware badge for a row (round-2 §1). Returns null for an
 * ordinary COMPLETED/UNKNOWN item — those keep the plain category/account/
 * date subtitle rather than a redundant "Completed" label on every normal row.
 * Every other lifecycle gets its own icon + exact required copy, and — the
 * safety-critical part — the caller must NEVER apply completed red/green
 * money styling when this returns non-null.
 */
fun lifecycleBadge(t: TransactionSummary): LifecycleBadge? = when (t.lifecycle) {
    "UPCOMING" -> LifecycleBadge(
        "Upcoming ${eventKindNoun(t.eventKind)}",
        "${expectedDateLabel(t.expectedAt)} · No money taken yet",
        LifecycleIconKind.INFO,
        LifecycleTone.NEUTRAL,
    )
    "PENDING" -> LifecycleBadge("Pending", "Not yet booked", LifecycleIconKind.INFO, LifecycleTone.NEUTRAL)
    "DECLINED" -> LifecycleBadge("Declined", "No money was deducted", LifecycleIconKind.WARNING, LifecycleTone.NEGATIVE)
    "FAILED" -> LifecycleBadge("Failed", "No money was deducted", LifecycleIconKind.WARNING, LifecycleTone.NEGATIVE)
    "CANCELLED" -> LifecycleBadge("Cancelled", "No money was deducted", LifecycleIconKind.WARNING, LifecycleTone.NEGATIVE)
    "REFUNDED" -> if (t.transactionType == "REFUND")
        LifecycleBadge("Refunded", null, LifecycleIconKind.REFRESH, LifecycleTone.POSITIVE)
    else
        LifecycleBadge("Reversed", null, LifecycleIconKind.REFRESH, LifecycleTone.NEUTRAL)
    else -> null
}

/** The exact required lifecycle message for the detail screen (round-2 §2). */
fun lifecycleMessage(t: TransactionSummary): String? = when (t.lifecycle) {
    "UPCOMING" -> "This payment is expected and has not affected your current balance."
    "PENDING" -> "This payment is pending and has not yet affected your booked balance."
    "DECLINED" -> "Payment declined — no money was deducted."
    "FAILED" -> "Payment failed — no money was deducted."
    "CANCELLED" -> "Payment cancelled — no money was deducted."
    "REFUNDED" -> if (t.transactionType == "REFUND") "This payment was refunded." else "This transaction was reversed; a correcting entry is recorded separately."
    else -> null
}

fun lifecycleLabel(lifecycle: String): String = when (lifecycle) {
    "UPCOMING" -> "Upcoming"
    "PENDING" -> "Pending"
    "DECLINED" -> "Declined"
    "FAILED" -> "Failed"
    "CANCELLED" -> "Cancelled"
    "REFUNDED" -> "Refunded"
    "COMPLETED" -> "Completed"
    else -> lifecycle.lowercase().replaceFirstChar { it.uppercase() }
}

fun paymentRailLabel(rail: String?): String? = when (rail) {
    "DIRECT_DEBIT" -> "Direct Debit"
    "CARD" -> "Card"
    "TRANSFER" -> "Bank transfer"
    "STANDING_ORDER" -> "Standing order"
    "CASH" -> "Cash"
    "OTHER" -> "Other"
    else -> null
}

/** Amount sign — suppressed for anything that hasn't (or, for a reversed
 *  original, effectively no longer) moved money as booked. Internal transfers
 *  are handled separately by the caller (never signed either way). */
fun amountPrefix(t: TransactionSummary, badge: LifecycleBadge?): String = when {
    badge != null && badge.tone != LifecycleTone.POSITIVE -> ""
    t.isInternalTransfer -> ""
    t.direction == "INCOME" -> "+"
    else -> "-"
}

/** A short, non-technical gloss for the classifier's internal reason code —
 *  never surfaces the raw code or any notification payload text. */
fun evidenceSummary(reasonCode: String): String = when {
    reasonCode.contains("DECLINE", ignoreCase = true) -> "Bank notification language indicated the payment was declined"
    reasonCode.contains("FAIL", ignoreCase = true) -> "Bank notification language indicated the payment failed"
    reasonCode.contains("FUTURE", ignoreCase = true) -> "Bank notification described a payment that hasn't happened yet"
    reasonCode.contains("PENDING", ignoreCase = true) -> "Bank notification indicated the payment is still pending"
    reasonCode.contains("CANCEL", ignoreCase = true) -> "Bank notification language indicated the payment was cancelled"
    reasonCode.contains("TRUSTED", ignoreCase = true) || reasonCode.contains("CLIENT_DECLARED", ignoreCase = true) -> "Reported by a recognised banking app"
    else -> "Classified from bank notification text"
}
