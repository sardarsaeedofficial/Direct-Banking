package uk.co.prisom.directbanking

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import uk.co.prisom.directbanking.data.remote.dto.TransactionItemDto
import uk.co.prisom.directbanking.data.repository.derivedLifecycle
import uk.co.prisom.directbanking.data.repository.toSummary

/**
 * The unified Activity DTO -> domain mapping (Financial Event Intelligence
 * round 2, §4). Covers the two traps that would otherwise silently break
 * lifecycle-aware rendering: a legacy /transactions row with no `lifecycle`
 * field, and a FinancialEvent row whose `status` field is simply absent from
 * the JSON (and must never leak its unrelated Kotlin default into the UI).
 */
class TransactionMappingTest {

    private fun dto(
        kind: String = "TRANSACTION",
        status: String = "COMPLETED",
        lifecycle: String? = null,
        transactionType: String? = null,
        eventKind: String? = null,
        displayName: String? = null,
        description: String? = "Fallback description",
        paymentRail: String? = null,
    ) = TransactionItemDto(
        id = "id-1", amountMinor = 1830, direction = "EXPENSE", currency = "GBP",
        description = description, status = status, transactionType = transactionType,
        kind = kind, displayName = displayName, eventKind = eventKind, lifecycle = lifecycle,
        paymentRail = paymentRail,
    )

    @Test
    fun `a legacy transactions-endpoint row with no lifecycle field derives COMPLETED from status`() {
        val t = dto(status = "COMPLETED", lifecycle = null).toSummary()
        assertEquals("COMPLETED", t.lifecycle)
        assertEquals("COMPLETED", t.status)
    }

    @Test
    fun `a legacy PENDING transaction row derives PENDING lifecycle`() {
        val t = dto(status = "PENDING", lifecycle = null).toSummary()
        assertEquals("PENDING", t.lifecycle)
    }

    @Test
    fun `a legacy REFUND-correction row derives REFUNDED lifecycle even though status says COMPLETED`() {
        val t = dto(status = "COMPLETED", transactionType = "REFUND", lifecycle = null).toSummary()
        assertEquals("REFUNDED", t.lifecycle)
    }

    @Test
    fun `a FinancialEvent row's meaningless default status never leaks into the domain model`() {
        // The server never sends a `status` key for a FINANCIAL_EVENT row, so
        // kotlinx.serialization decodes it to the DTO's unrelated Kotlin
        // default ("COMPLETED") — toSummary() must override that with the
        // real lifecycle, never show "Completed" for an UPCOMING event.
        val t = dto(kind = "FINANCIAL_EVENT", status = "COMPLETED", lifecycle = "UPCOMING", eventKind = "CREDIT_CARD_REPAYMENT").toSummary()
        assertEquals("UPCOMING", t.lifecycle)
        assertEquals("UPCOMING", t.status) // never "COMPLETED"
        assertEquals("FINANCIAL_EVENT", t.kind)
        assertTrue(t.isFinancialEvent)
    }

    @Test
    fun `displayName from the unified item wins over the legacy description fallback chain`() {
        val t = dto(displayName = "Zable", description = "some raw description").toSummary()
        assertEquals("Zable", t.description)
    }

    @Test
    fun `paymentRail passes through unchanged`() {
        val t = dto(paymentRail = "DIRECT_DEBIT").toSummary()
        assertEquals("DIRECT_DEBIT", t.paymentRail)
    }

    @Test
    fun `derivedLifecycle prefers the server lifecycle field when present, over any status guess`() {
        val d = dto(status = "COMPLETED", lifecycle = "DECLINED")
        assertEquals("DECLINED", d.derivedLifecycle())
    }
}
