package uk.co.prisom.directbanking.parsing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TransferParsingTest {

    @Test fun `extracts a recipient from an outgoing payment`() {
        assertEquals("Sardar Saeed", TransferParsing.recipient("You sent £100 to Sardar Saeed"))
        assertEquals("Sardar Saeed", TransferParsing.recipient("Payment to Sardar Saeed of £50"))
    }

    @Test fun `extracts a sender from an incoming payment`() {
        assertEquals("Sardar Saeed", TransferParsing.sender("£2 from Sardar Saeed: Sent from Revolut"))
        assertEquals("ACME Payroll", TransferParsing.sender("You received £2000 from ACME Payroll"))
    }

    @Test fun `extracts a reference when present`() {
        assertEquals("INV-2043", TransferParsing.reference("Payment received. Ref: INV-2043"))
        assertEquals("RENT", TransferParsing.reference("Reference RENT"))
    }

    @Test fun `returns null when a field is absent`() {
        assertNull(TransferParsing.recipient("You spent £12.45 at Tesco"))
        assertNull(TransferParsing.reference("You spent £12.45 at Tesco"))
    }

    @Test fun `enriches a generic outgoing transfer candidate`() {
        val input = NotificationInput("com.example.bank", 1_000L, "Bank", "You sent £100 to Sardar Saeed", null, emptyList(), null)
        val c = GenericFinancialParser().parse(input)!!
        assertEquals(TransactionDirection.EXPENSE, c.direction)
        assertEquals(10000L, c.amountMinor)
        assertEquals("Sardar Saeed", c.recipientName)
        assertNull(c.senderName)
    }

    @Test fun `enriches a Monzo incoming transfer candidate with the sender`() {
        val input = NotificationInput("co.uk.getmondo", 1_000L, "Monzo", "£2 from Sardar Saeed: Sent from Revolut", null, emptyList(), null)
        val c = MonzoParser().parse(input)!!
        assertEquals(TransactionDirection.INCOME, c.direction)
        assertEquals("Sardar Saeed", c.senderName)
    }
}
