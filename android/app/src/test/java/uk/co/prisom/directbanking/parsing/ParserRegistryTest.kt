package uk.co.prisom.directbanking.parsing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class ParserRegistryTest {

    private val registry = ParserRegistry()

    @Test
    fun `all fixtures parse as expected`() {
        val failures = mutableListOf<String>()
        for (f in NotificationFixtures.all) {
            val result = registry.parse(f.input)
            if (!f.parseable) {
                if (result != null) failures += "${f.name}: expected no parse, got $result"
                continue
            }
            if (result == null) { failures += "${f.name}: expected a parse, got null"; continue }
            if (f.direction != null && result.direction != f.direction) failures += "${f.name}: direction ${result.direction} != ${f.direction}"
            if (f.amountMinor != null && result.amountMinor != f.amountMinor) failures += "${f.name}: amount ${result.amountMinor} != ${f.amountMinor}"
            if (result.currency != f.currency) failures += "${f.name}: currency ${result.currency} != ${f.currency}"
            f.merchantContains?.let { if (result.merchant?.contains(it, ignoreCase = true) != true) failures += "${f.name}: merchant '${result.merchant}' !contains '$it'" }
            f.minConfidence?.let { if (result.confidence < it) failures += "${f.name}: confidence ${result.confidence} < $it" }
            f.maxConfidence?.let { if (result.confidence > it) failures += "${f.name}: confidence ${result.confidence} > $it" }
        }
        assertTrue("Fixture failures:\n" + failures.joinToString("\n"), failures.isEmpty())
    }

    @Test
    fun `fixture count is at least 30`() {
        assertTrue(NotificationFixtures.all.size >= 30)
    }

    @Test
    fun `deterministic adapter beats generic confidence for known bank`() {
        val monzo = registry.parse(NotificationInput("co.uk.getmondo", 1L, title = "Tesco", text = "You spent £12.45"))!!
        val generic = registry.parse(NotificationInput("com.example.bank", 1L, text = "You spent £12.45 at Tesco"))!!
        assertTrue(monzo.confidence >= 0.90)
        assertTrue(generic.confidence <= 0.85)
    }

    @Test
    fun `occurredAt derives from postTime`() {
        val result = registry.parse(NotificationInput("com.example.bank", 1_700_000_000_000L, text = "You spent £1.00 at Shop"))!!
        assertEquals(Instant.ofEpochMilli(1_700_000_000_000L), result.occurredAt)
    }

    @Test
    fun `redacted text carries no raw long card number`() {
        val result = registry.parse(NotificationInput("com.example.bank", 1L, text = "You spent £5.00 on card 4242 4242 4242 4242"))
        assertNotNull(result)
        assertTrue(result!!.redactedSourceText.contains("4242"))
        assertTrue("should not keep full PAN", !result.redactedSourceText.contains("4242 4242 4242 4242"))
    }

    @Test
    fun `unrecognised delivery notification does not parse`() {
        assertNull(registry.parse(NotificationInput("com.example.delivery", 1L, text = "Your parcel is out for delivery")))
    }
}
