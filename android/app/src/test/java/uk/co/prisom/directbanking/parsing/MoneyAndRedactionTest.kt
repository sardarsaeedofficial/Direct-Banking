package uk.co.prisom.directbanking.parsing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MoneyTest {
    @Test fun `toMinor handles thousands and decimals`() {
        assertEquals(123456L, Money.toMinor("1,234.56"))
        assertEquals(1245L, Money.toMinor("12.45"))
        assertEquals(2000L, Money.toMinor("20"))
        assertEquals(550L, Money.toMinor("5.5"))
    }

    @Test fun `firstAmount detects symbol prefix`() {
        val a = Money.firstAmount("You spent £12.45 at Tesco")!!
        assertEquals(1245L, a.minor); assertEquals("GBP", a.currency)
    }

    @Test fun `firstAmount detects word prefix and suffix`() {
        assertEquals("GBP", Money.firstAmount("GBP 1,234.56 paid")!!.currency)
        assertEquals(123456L, Money.firstAmount("1,234.56 GBP paid")!!.minor)
    }

    @Test fun `firstAmount detects negative`() {
        assertTrue(Money.firstAmount("-£12.50")!!.negative)
    }

    @Test fun `firstAmount requires a currency signal`() {
        assertNull(Money.firstAmount("You have 3 new messages"))
    }

    @Test fun `format renders minor units`() {
        assertEquals("£12.45", Money.format(1245, "GBP"))
        assertEquals("£1.05", Money.format(105, "GBP"))
    }
}

class RedactionTest {
    @Test fun `masks a full card number keeping last four`() {
        val out = Redaction.redact("Payment on card 4242 4242 4242 4242 today")
        assertTrue(out.contains("4242"))
        assertTrue(!out.contains("4242 4242 4242 4242"))
    }

    @Test fun `masks long account digit runs`() {
        val out = Redaction.redact("Account 12345678 debited")
        assertTrue(out.contains("5678"))
        assertTrue(!out.contains("12345678"))
    }

    @Test fun `extracts account hint from ending`() {
        assertEquals("1234", Redaction.accountHint("Card ending 1234 used"))
        assertEquals("4321", Redaction.accountHint("on card •• 4321"))
    }
}

class FingerprintTest {
    @Test fun `same inputs within window produce same fingerprint`() {
        val a = Fingerprint.compute("u", "d", "com.bank", 1245, TransactionDirection.EXPENSE, "Tesco", 1_000_000L)
        val b = Fingerprint.compute("u", "d", "com.bank", 1245, TransactionDirection.EXPENSE, "TESCO!", 1_000_000L + 5_000L)
        assertEquals(a, b)
    }

    @Test fun `different amount produces different fingerprint`() {
        val a = Fingerprint.compute("u", "d", "com.bank", 1245, TransactionDirection.EXPENSE, "Tesco", 1_000_000L)
        val b = Fingerprint.compute("u", "d", "com.bank", 1300, TransactionDirection.EXPENSE, "Tesco", 1_000_000L)
        assertTrue(a != b)
    }

    @Test fun `far apart timestamps produce different fingerprint`() {
        val a = Fingerprint.compute("u", "d", "com.bank", 1245, TransactionDirection.EXPENSE, "Tesco", 1_000_000L)
        val b = Fingerprint.compute("u", "d", "com.bank", 1245, TransactionDirection.EXPENSE, "Tesco", 1_000_000L + 10 * Fingerprint.WINDOW_MILLIS)
        assertTrue(a != b)
    }
}

class SourceFilterTest {
    @Test fun `ignores direct banking itself and system`() {
        assertTrue(SourceFilter.isIgnoredPackage("uk.co.prisom.directbanking"))
        assertTrue(SourceFilter.isIgnoredPackage("uk.co.prisom.directbanking.debug"))
        assertTrue(SourceFilter.isIgnoredPackage("com.android.systemui"))
    }

    @Test fun `ignores messaging and email and authenticators`() {
        assertTrue(SourceFilter.isIgnoredPackage("com.whatsapp"))
        assertTrue(SourceFilter.isIgnoredPackage("com.google.android.gm"))
        assertTrue(SourceFilter.isIgnoredPackage("com.azure.authenticator"))
    }

    @Test fun `allows a real bank package`() {
        assertTrue(!SourceFilter.isIgnoredPackage("com.starlingbank.android"))
    }

    @Test fun `blocks otp text at baseline`() {
        assertTrue(!SourceFilter.passesBaseline("com.example.bank", "Your verification code is 123456"))
        assertTrue(SourceFilter.passesBaseline("com.example.bank", "You spent £12.45 at Tesco"))
    }
}
