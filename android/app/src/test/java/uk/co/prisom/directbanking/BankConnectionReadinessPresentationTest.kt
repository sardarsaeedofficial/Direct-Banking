package uk.co.prisom.directbanking

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import uk.co.prisom.directbanking.data.remote.dto.BankConnectionsReadiness
import uk.co.prisom.directbanking.ui.connectBankButtonLabel
import uk.co.prisom.directbanking.ui.readinessBlockingMessage

/**
 * The four exact required Bank Connections messages (Financial Event
 * Intelligence round 2, §7) — must never fall back to a raw backend error.
 */
class BankConnectionReadinessPresentationTest {

    @Test
    fun `disabled reads exactly as required`() {
        val r = BankConnectionsReadiness(enabled = false, configured = false, reason = "DISABLED")
        assertEquals("Bank connections are currently disabled.", readinessBlockingMessage(r))
    }

    @Test
    fun `not configured with no provider named reads exactly as required`() {
        val r = BankConnectionsReadiness(enabled = true, configured = false, reason = "NOT_CONFIGURED", missing = listOf("OPEN_BANKING_PROVIDER"))
        assertEquals("Bank connection provider has not been configured.", readinessBlockingMessage(r))
    }

    @Test
    fun `not configured with a provider named but incomplete Plaid config reads exactly as required`() {
        val r = BankConnectionsReadiness(
            enabled = true, provider = "plaid", configured = false, reason = "NOT_CONFIGURED",
            missing = listOf("PLAID_CLIENT_ID", "PLAID_SECRET"),
        )
        assertEquals("Bank connections are not fully configured yet.", readinessBlockingMessage(r))
    }

    @Test
    fun `ready has no blocking message`() {
        val r = BankConnectionsReadiness(enabled = true, provider = "plaid", environment = "sandbox", configured = true, reason = "READY")
        assertNull(readinessBlockingMessage(r))
    }

    @Test
    fun `never leaks a raw backend reason or provider name into the blocking message`() {
        val r = BankConnectionsReadiness(
            enabled = true, provider = "some-unexpected-value", configured = false, reason = "SOME_FUTURE_REASON",
        )
        // An unrecognised reason fails open to "no message" rather than
        // surfacing whatever the server actually sent.
        assertNull(readinessBlockingMessage(r))
    }

    @Test
    fun `connect button label is exactly Connect a bank when ready and no connection exists yet`() {
        assertEquals("Connect a bank", connectBankButtonLabel(isFirstConnection = true, starting = false))
    }

    @Test
    fun `connect button label shows a starting state and a distinct label once a connection already exists`() {
        assertEquals("Starting…", connectBankButtonLabel(isFirstConnection = true, starting = true))
        assertEquals("+ Connect another bank", connectBankButtonLabel(isFirstConnection = false, starting = false))
    }
}
