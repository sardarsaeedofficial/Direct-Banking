package uk.co.prisom.directbanking

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import uk.co.prisom.directbanking.domain.TransactionSummary
import uk.co.prisom.directbanking.ui.LifecycleTone
import uk.co.prisom.directbanking.ui.amountPrefix
import uk.co.prisom.directbanking.ui.expectedDateLabel
import uk.co.prisom.directbanking.ui.lifecycleBadge
import uk.co.prisom.directbanking.ui.lifecycleLabel
import uk.co.prisom.directbanking.ui.lifecycleMessage
import uk.co.prisom.directbanking.ui.paymentRailLabel

/**
 * Regression coverage for the Financial Event Intelligence round-2 Activity
 * lifecycle rendering (§1/§2/§9) — the exact list-row and detail-screen copy
 * the brief requires, and the safety-critical rule that non-completed
 * lifecycles never get the completed red/green money treatment.
 */
class ActivityLifecyclePresentationTest {

    private fun event(
        lifecycle: String,
        eventKind: String? = null,
        expectedAt: String? = null,
        transactionType: String? = null,
        direction: String? = "EXPENSE",
    ) = TransactionSummary(
        id = "x", amountMinor = 1000, direction = direction ?: "EXPENSE", currency = "GBP",
        description = "Merchant", merchant = "Merchant", category = null, account = "Current", bookedAt = "2026-08-15T10:00:00.000Z",
        status = lifecycle, transactionType = transactionType,
        kind = if (eventKind != null) "FINANCIAL_EVENT" else "TRANSACTION",
        eventKind = eventKind, lifecycle = lifecycle, expectedAt = expectedAt,
        ledgerPosted = lifecycle == "COMPLETED",
    )

    // ---- Zable fixture: UPCOMING CREDIT_CARD_REPAYMENT ----
    @Test
    fun `upcoming credit-card repayment matches the required Zable-style copy`() {
        val t = event("UPCOMING", eventKind = "CREDIT_CARD_REPAYMENT", expectedAt = "2026-08-20T00:00:00.000Z")
        val badge = lifecycleBadge(t)!!
        assertEquals("Upcoming credit-card repayment", badge.statusText)
        assertTrue(badge.subText!!.contains("Expected 20 Aug"))
        assertTrue(badge.subText!!.contains("No money taken yet"))
        assertEquals("", amountPrefix(t, badge)) // never signed/completed-styled
        assertEquals(LifecycleTone.NEUTRAL, badge.tone)
        assertEquals("This payment is expected and has not affected your current balance.", lifecycleMessage(t))
    }

    // ---- Halifax fixture: UPCOMING DIRECT_DEBIT ----
    @Test
    fun `upcoming direct debit matches the required Halifax-style copy`() {
        val t = event("UPCOMING", eventKind = "DIRECT_DEBIT", expectedAt = null)
        val badge = lifecycleBadge(t)!!
        assertEquals("Upcoming Direct Debit", badge.statusText)
        assertTrue(badge.subText!!.contains("No money taken yet"))
        assertEquals("", amountPrefix(t, badge))
    }

    // ---- AliExpress fixture: DECLINED ----
    @Test
    fun `declined matches the required AliExpress-style copy and is never signed`() {
        val t = event("DECLINED", eventKind = "CARD_PURCHASE")
        val badge = lifecycleBadge(t)!!
        assertEquals("Declined", badge.statusText)
        assertEquals("No money was deducted", badge.subText)
        assertEquals("", amountPrefix(t, badge))
        assertEquals(LifecycleTone.NEGATIVE, badge.tone)
        assertEquals("Payment declined — no money was deducted.", lifecycleMessage(t))
    }

    @Test
    fun `pending matches the required copy`() {
        val t = event("PENDING")
        val badge = lifecycleBadge(t)!!
        assertEquals("Pending", badge.statusText)
        assertEquals("Not yet booked", badge.subText)
        assertEquals("", amountPrefix(t, badge))
        assertEquals("This payment is pending and has not yet affected your booked balance.", lifecycleMessage(t))
    }

    @Test
    fun `failed matches the required copy`() {
        val t = event("FAILED")
        val badge = lifecycleBadge(t)!!
        assertEquals("Failed", badge.statusText)
        assertEquals("No money was deducted", badge.subText)
        assertEquals("Payment failed — no money was deducted.", lifecycleMessage(t))
    }

    @Test
    fun `cancelled matches the required copy`() {
        val t = event("CANCELLED")
        val badge = lifecycleBadge(t)!!
        assertEquals("Cancelled", badge.statusText)
        assertEquals("No money was deducted", badge.subText)
        assertEquals("Payment cancelled — no money was deducted.", lifecycleMessage(t))
    }

    @Test
    fun `refund correction is signed positive and labelled Refunded, distinct from a reversed original`() {
        val refund = event("REFUNDED", transactionType = "REFUND", direction = "INCOME")
        val refundBadge = lifecycleBadge(refund)!!
        assertEquals("Refunded", refundBadge.statusText)
        assertEquals(LifecycleTone.POSITIVE, refundBadge.tone)
        assertEquals("+", amountPrefix(refund, refundBadge))

        val reversedOriginal = event("REFUNDED", transactionType = "PURCHASE", direction = "EXPENSE")
        val reversedBadge = lifecycleBadge(reversedOriginal)!!
        assertEquals("Reversed", reversedBadge.statusText)
        assertEquals(LifecycleTone.NEUTRAL, reversedBadge.tone)
        assertEquals("", amountPrefix(reversedOriginal, reversedBadge)) // no sign — distinct from the refund credit
    }

    @Test
    fun `completed transactions have no badge and are signed normally (expense minus, income plus)`() {
        val expense = event("COMPLETED", direction = "EXPENSE")
        assertNull(lifecycleBadge(expense))
        assertEquals("-", amountPrefix(expense, null))
        assertNull(lifecycleMessage(expense))

        val income = event("COMPLETED", direction = "INCOME")
        assertEquals("+", amountPrefix(income, null))
    }

    @Test
    fun `credit-card repayment is never signed as income, whatever its direction field says`() {
        // Defensive: even if a row somehow carried direction=INCOME, a
        // completed repayment must never render with a "+" (Income) sign.
        val t = TransactionSummary(
            id = "cc", amountMinor = 5000, direction = "EXPENSE", currency = "GBP",
            description = "Zable", merchant = "Zable", category = null, account = "Current", bookedAt = "2026-08-15T10:00:00.000Z",
            status = "COMPLETED", transactionType = "CREDIT_CARD_REPAYMENT",
            kind = "TRANSACTION", eventKind = null, lifecycle = "COMPLETED",
        )
        assertTrue(t.isCreditCardRepayment)
        assertEquals("-", amountPrefix(t, lifecycleBadge(t)))
    }

    @Test
    fun `lifecycleLabel covers every state with a human-readable word`() {
        assertEquals("Upcoming", lifecycleLabel("UPCOMING"))
        assertEquals("Pending", lifecycleLabel("PENDING"))
        assertEquals("Declined", lifecycleLabel("DECLINED"))
        assertEquals("Failed", lifecycleLabel("FAILED"))
        assertEquals("Cancelled", lifecycleLabel("CANCELLED"))
        assertEquals("Refunded", lifecycleLabel("REFUNDED"))
        assertEquals("Completed", lifecycleLabel("COMPLETED"))
    }

    @Test
    fun `paymentRailLabel translates every known rail and hides unknown values`() {
        assertEquals("Direct Debit", paymentRailLabel("DIRECT_DEBIT"))
        assertEquals("Card", paymentRailLabel("CARD"))
        assertEquals("Bank transfer", paymentRailLabel("TRANSFER"))
        assertEquals("Standing order", paymentRailLabel("STANDING_ORDER"))
        assertEquals("Cash", paymentRailLabel("CASH"))
        assertNull(paymentRailLabel(null))
    }

    @Test
    fun `expectedDateLabel formats a real date and falls back safely for a missing one`() {
        assertEquals("Expected 20 Aug", expectedDateLabel("2026-08-20T00:00:00.000Z"))
        assertEquals("Expected soon", expectedDateLabel(null))
        assertEquals("Expected soon", expectedDateLabel("not-a-date"))
    }
}
