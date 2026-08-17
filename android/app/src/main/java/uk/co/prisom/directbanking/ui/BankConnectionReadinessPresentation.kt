package uk.co.prisom.directbanking.ui

import uk.co.prisom.directbanking.data.remote.dto.BankConnectionsReadiness

/**
 * Exact required Bank Connections copy (Financial Event Intelligence round 2,
 * §7) — kept as a pure function, separate from BankConnectionScreens.kt's
 * Composables, so it is plain-JVM-testable without Robolectric. Never a raw
 * backend/provider error string; returns null exactly when nothing blocks
 * connecting ("READY").
 */
fun readinessBlockingMessage(r: BankConnectionsReadiness): String? = when (r.reason) {
    "DISABLED" -> "Bank connections are currently disabled."
    "NOT_CONFIGURED" -> if (r.missing.contains("OPEN_BANKING_PROVIDER"))
        "Bank connection provider has not been configured."
    else
        "Bank connections are not fully configured yet."
    else -> null // "READY" (or an unrecognised future value — fail open to no message)
}

/** The primary CTA label — "Connect a bank" exactly, when ready and this is
 *  the first connection; "+ Connect another bank" once one already exists
 *  (not a string the brief specifies, but a reasonable, additive extension
 *  for the multi-connection case). */
fun connectBankButtonLabel(isFirstConnection: Boolean, starting: Boolean): String = when {
    starting -> "Starting…"
    isFirstConnection -> "Connect a bank"
    else -> "+ Connect another bank"
}
