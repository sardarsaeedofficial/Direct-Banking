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
    val lastResult: String? = null,
    val lastReason: String? = null,
)

/** In-memory diagnostics for the notification pipeline (no raw text retained). */
class DiagnosticsRepository {
    private val _state = MutableStateFlow(DiagnosticsSnapshot())
    val state: StateFlow<DiagnosticsSnapshot> = _state.asStateFlow()

    fun setConnected(connected: Boolean) {
        _state.value = _state.value.copy(listenerConnected = connected)
    }

    fun recordCapture(
        pkg: String,
        label: String?,
        receivedAtMillis: Long,
        redactedTitle: String?,
        redactedText: String?,
        result: String,
        reason: String,
    ) {
        _state.value = _state.value.copy(
            lastPackage = pkg,
            lastLabel = label,
            lastReceivedAtMillis = receivedAtMillis,
            lastRedactedTitle = redactedTitle,
            lastRedactedText = redactedText,
            lastResult = result,
            lastReason = reason,
        )
    }
}
