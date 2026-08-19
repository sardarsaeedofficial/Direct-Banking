package uk.co.prisom.directbanking.parsing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Capital One (com.ie.capitalone.uk) real card-authorisation notification
 * format: "£4.88 on card ending 7813. That leaves £202.51 available to
 * spend" — the exact shape that used to surface as "Transaction detected —
 * review £0.00" (round-2 §1-4). Dedicated unit tests, separate from
 * [ParserRegistryTest]'s generic fixture table, because the multi-amount
 * avoidance behaviour deserves its own explicit coverage rather than being
 * folded into one fixture-table row.
 */
class CapitalOneParserTest {

    private val parser = CapitalOneParser()
    private val registry = ParserRegistry()
    private val pkg = CapitalOneParser.PACKAGE

    private fun input(title: String?, text: String) =
        NotificationInput(sourcePackage = pkg, postTime = 1_722_800_000_000L, title = title, text = text)

    @Test fun `verified package constant`() {
        assertEquals("com.ie.capitalone.uk", pkg)
    }

    @Test fun `CASE A - £4_88 purchase extracts the transaction amount, never the available-to-spend figure`() {
        val r = parser.parse(input("ALIEXPRESS.COM", "£4.88 on card ending 7813. That leaves £202.51 available to spend"))!!
        assertEquals(488L, r.amountMinor)
        assertEquals("GBP", r.currency)
        assertEquals(TransactionDirection.EXPENSE, r.direction)
        assertEquals("ALIEXPRESS.COM", r.merchant)
        assertEquals("7813", r.accountHint)
        assertTrue("deterministic bank adapter should be high-confidence", r.confidence >= 0.9)
    }

    @Test fun `CASE B - a second £1_74 purchase on the same card parses independently with its own amount`() {
        val r = parser.parse(input("ALIEXPRESS.COM", "£1.74 on card ending 7813. That leaves £202.51 available to spend"))!!
        assertEquals(174L, r.amountMinor)
        assertEquals("7813", r.accountHint)
        // Never conflated with CASE A's £4.88 — independently derived from its own text.
        assertNotEquals(488L, r.amountMinor)
    }

    @Test fun `the available-to-spend figure never becomes the amount even when it is the larger number`() {
        val r = parser.parse(input("ALIEXPRESS.COM", "£4.88 on card ending 7813. That leaves £202.51 available to spend"))!!
        assertEquals(488L, r.amountMinor) // not 20251 (the £202.51 balance)
    }

    @Test fun `never produces a £0_00 candidate for a real Capital One notification`() {
        val r = parser.parse(input("ALIEXPRESS.COM", "£4.88 on card ending 7813. That leaves £202.51 available to spend"))!!
        assertTrue(r.amountMinor > 0L)
    }

    @Test fun `declined wording still extracts the correct amount and card hint (lifecycle is decided server-side, not here)`() {
        val r = parser.parse(input("ALIEXPRESS.COM", "Your £4.88 payment on card ending 7813 was declined"))!!
        assertEquals(488L, r.amountMinor)
        assertEquals("7813", r.accountHint)
    }

    @Test fun `refund wording classifies as income`() {
        val r = parser.parse(input("ALIEXPRESS.COM", "£4.88 refunded to card ending 7813"))!!
        assertEquals(488L, r.amountMinor)
        assertEquals(TransactionDirection.INCOME, r.direction)
    }

    @Test fun `unrelated package is never handled`() {
        assertNull(parser.parse(NotificationInput("com.some.unrelated.app", 1L, title = "ALIEXPRESS.COM", text = "£4.88 on card ending 7813. That leaves £202.51 available to spend")))
    }

    @Test fun `blank text does not parse`() {
        assertNull(parser.parse(input("ALIEXPRESS.COM", "")))
    }

    @Test fun `redacted text never leaks the full card number, only the last 4`() {
        val r = parser.parse(input("ALIEXPRESS.COM", "£4.88 on card ending 7813. That leaves £202.51 available to spend"))!!
        assertTrue(r.redactedSourceText.contains("7813"))
    }

    @Test fun `Money countAmounts sees both the transaction amount and the available-to-spend figure`() {
        // Diagnostics-only signal (round-2 §12) — never used to change parsing.
        assertEquals(2, Money.countAmounts("£4.88 on card ending 7813. That leaves £202.51 available to spend"))
    }

    // ---- Registry wiring ----

    @Test fun `ParserRegistry routes the Capital One package to CapitalOneParser`() {
        val r = registry.parse(input("ALIEXPRESS.COM", "£4.88 on card ending 7813. That leaves £202.51 available to spend"))!!
        assertEquals(488L, r.amountMinor)
        assertEquals("CapitalOneParser", registry.selectedParserName(pkg))
    }

    @Test fun `ParserRegistry reports Generic for an unrecognised package`() {
        assertEquals("Generic", registry.selectedParserName("com.some.unrelated.app"))
    }

    private fun assertNotEquals(unexpected: Long, actual: Long) {
        assertTrue("expected not equal to $unexpected but was $actual", unexpected != actual)
        assertNotNull(actual)
    }
}
