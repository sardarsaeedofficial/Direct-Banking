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
    val trustLevel: String? = null,
    val builtInTrusted: Boolean = false,
    val signatureChecked: Boolean = false,
    val signatureMatched: Boolean? = null,
    val signingSha256Abbrev: String? = null,
    val autoImportEnabled: Boolean = false,
    val linkedAccountId: String? = null,
    val parsedAmountMinor: Long? = null,
    val parsedDirection: String? = null,
    val parsedCurrency: String? = null,
    val confidence: Double? = null,
    val importResult: String? = null,
    val transactionId: String? = null,
    val failureReason: String? = null,
    // ---- Round-2 (§1): diagnosable without exposing every notification body ----
    /** Which parser matched this source ("CapitalOneParser", "Generic", …). */
    val parserSelected: String? = null,
    /** The capture pipeline's own free-text account of what happened
     *  (e.g. "missing amount or direction", "select which account this
     *  belongs to", "auto-imported"). */
    val semanticResult: String? = null,
    /** How many distinct currency-signalled amounts the notification text
     *  carried — 2+ is exactly the shape ("transaction amount" + "available
     *  to spend") that used to silently fail. */
    val amountCandidateCount: Int? = null,
    /** Coarse role of the amount actually used, when one was produced. */
    val selectedAmountRole: String? = null,
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
        trustLevel: String?,
        builtInTrusted: Boolean,
        signatureChecked: Boolean,
        signatureMatched: Boolean?,
        signingSha256Abbrev: String?,
        autoImportEnabled: Boolean,
        linkedAccountId: String?,
        parsedAmountMinor: Long?,
        parsedDirection: String?,
        parsedCurrency: String?,
        confidence: Double?,
        importResult: String,
        transactionId: String?,
        failureReason: String,
        parserSelected: String? = null,
        semanticResult: String? = null,
        amountCandidateCount: Int? = null,
        selectedAmountRole: String? = null,
    ) {
        _state.value = _state.value.copy(
            lastPackage = pkg,
            lastLabel = label,
            lastReceivedAtMillis = receivedAtMillis,
            lastRedactedTitle = redactedTitle,
            lastRedactedText = redactedText,
            sourceTrustedOrApproved = sourceTrustedOrApproved,
            trustLevel = trustLevel,
            builtInTrusted = builtInTrusted,
            signatureChecked = signatureChecked,
            signatureMatched = signatureMatched,
            signingSha256Abbrev = signingSha256Abbrev,
            autoImportEnabled = autoImportEnabled,
            linkedAccountId = linkedAccountId,
            parsedAmountMinor = parsedAmountMinor,
            parsedDirection = parsedDirection,
            parsedCurrency = parsedCurrency,
            confidence = confidence,
            importResult = importResult,
            transactionId = transactionId,
            failureReason = failureReason,
            parserSelected = parserSelected,
            semanticResult = semanticResult,
            amountCandidateCount = amountCandidateCount,
            selectedAmountRole = selectedAmountRole,
        )
    }
}
