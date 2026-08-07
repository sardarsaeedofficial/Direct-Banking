package uk.co.prisom.directbanking.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Redacted, non-persistent view of the last notification the listener handled. */
data class DiagnosticsSnapshot(
    val listenerConnected: Boolean = false,
    val lastPackage: String? = null,
    val lastLabel: String? = null,
    val lastReceivedAtMillis: Long? = null,
    val lastRedactedTitle: String? = null,
    val lastRedactedText: String? = null,
    val sourceTrustedOrApproved: Boolean = false,
    val autoImportEnabled: Boolean = false,
    val linkedAccountId: String? = null,
    val parsedAmountMinor: Long? = null,
    val parsedDirection: String? = null,
    val parsedCurrency: String? = null,
    val confidence: Double? = null,
    val importResult: String? = null,
    val transactionId: String? = null,
    val failureReason: String? = null,
)

/** In-memory diagnostics for the notification pipeline (no raw text retained). */
class DiagnosticsRepository {
    private val _state = MutableStateFlow(DiagnosticsSnapshot())
    val state: StateFlow<DiagnosticsSnapshot> = _state.asStateFlow()

    fun setConnected(connected: Boolean) {
        _state.value = _state.value.copy(listenerConnected = connected)
    }

    @Suppress("LongParameterList")
    fun recordCapture(
        pkg: String,
        label: String?,
        receivedAtMillis: Long,
        redactedTitle: String?,
        redactedText: String?,
        sourceTrustedOrApproved: Boolean,
        autoImportEnabled: Boolean,
        linkedAccountId: String?,
        parsedAmountMinor: Long?,
        parsedDirection: String?,
        parsedCurrency: String?,
        confidence: Double?,
        importResult: String,
        transactionId: String?,
        failureReason: String,
    ) {
        _state.value = _state.value.copy(
            lastPackage = pkg,
            lastLabel = label,
            lastReceivedAtMillis = receivedAtMillis,
            lastRedactedTitle = redactedTitle,
            lastRedactedText = redactedText,
            sourceTrustedOrApproved = sourceTrustedOrApproved,
            autoImportEnabled = autoImportEnabled,
            linkedAccountId = linkedAccountId,
            parsedAmountMinor = parsedAmountMinor,
            parsedDirection = parsedDirection,
            parsedCurrency = parsedCurrency,
            confidence = confidence,
            importResult = importResult,
            transactionId = transactionId,
            failureReason = failureReason,
        )
    }
}
