package uk.co.prisom.directbanking.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// Transaction Intelligence Engine (§18): the Android Activity detail screen
// must show economic meaning correctly — a credit-card repayment is never
// "counted as spending", an internal transfer is never income/spending, an
// UPCOMING/PENDING event has no analytics role to show yet.
class TransactionSummaryAnalyticsSummaryTest {
    private fun txn(
        direction: String = "EXPENSE",
        transactionType: String? = null,
        lifecycle: String = "COMPLETED",
        internalTransferConfidence: String? = null,
    ) = TransactionSummary(
        id = "t1", amountMinor = 100, direction = direction, currency = "GBP",
        description = "Test", merchant = null, category = null, account = "Monzo",
        bookedAt = "2026-08-21T00:00:00Z", status = "COMPLETED",
        transactionType = transactionType, lifecycle = lifecycle,
        internalTransferConfidence = internalTransferConfidence,
    )

    @Test fun `a credit-card repayment is never counted as spending`() {
        assertEquals("Not counted as spending", txn(transactionType = "CREDIT_CARD_REPAYMENT").analyticsSummary)
    }

    @Test fun `a confirmed internal transfer is neither income nor spending`() {
        assertEquals("Not income / not spending", txn(direction = "INCOME", transactionType = "INTERNAL_TRANSFER").analyticsSummary)
    }

    @Test fun `a possible (unconfirmed) transfer is also neither income nor spending`() {
        assertEquals("Not income / not spending", txn(direction = "INCOME", internalTransferConfidence = "POSSIBLE").analyticsSummary)
    }

    @Test fun `a refund is never counted as spending`() {
        assertEquals("Refund — not counted as spending", txn(transactionType = "REFUND").analyticsSummary)
    }

    @Test fun `an ordinary completed expense is counted as spending`() {
        assertEquals("Counted as spending", txn(direction = "EXPENSE", transactionType = "PURCHASE").analyticsSummary)
    }

    @Test fun `an ordinary completed income is counted as income`() {
        assertEquals("Counted as income", txn(direction = "INCOME").analyticsSummary)
    }

    @Test fun `an UPCOMING event has no analytics role yet — never guessed`() {
        assertNull(txn(lifecycle = "UPCOMING").analyticsSummary)
    }

    @Test fun `a PENDING event has no analytics role yet`() {
        assertNull(txn(lifecycle = "PENDING").analyticsSummary)
    }
}
