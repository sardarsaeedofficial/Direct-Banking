package uk.co.prisom.directbanking.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Lightweight process-wide signal that dashboard/activity data changed (e.g. an
 * automatic import recorded a transaction). Screens observe [tick] to refresh
 * without the user pressing Refresh.
 */
object RefreshSignal {
    private val _tick = MutableStateFlow(0L)
    val tick: StateFlow<Long> = _tick.asStateFlow()

    fun trigger() {
        _tick.value = _tick.value + 1
    }
}
