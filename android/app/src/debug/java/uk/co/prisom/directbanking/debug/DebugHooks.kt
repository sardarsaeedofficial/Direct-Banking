package uk.co.prisom.directbanking.debug

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import kotlinx.coroutines.launch
import uk.co.prisom.directbanking.notifications.BankNotificationListenerService
import uk.co.prisom.directbanking.notifications.RawNotification
import uk.co.prisom.directbanking.ui.LocalContainer

/** Debug-only hooks. The release variant provides a no-op version of this file. */
object DebugHooks {
    val simulatorRoute: String? = "debug/simulator"
}

fun NavGraphBuilder.addDebugDestinations(navController: NavController) {
    composable("debug/simulator") { DebugSimulatorScreen() }
}

private const val SIM_PKG = "com.example.simulatedbank"
private const val FIXED_TIME = 1_754_000_000_000L // stable time so duplicates collide

private data class Scenario(val label: String, val build: () -> RawNotification)

private fun raw(text: String, time: Long = System.currentTimeMillis()) = RawNotification(
    packageName = SIM_PKG, postTime = time, key = "sim-$text", category = null,
    title = "Simulated Bank", text = text, bigText = null, textLines = emptyList(), subText = null,
)

private val scenarios = listOf(
    Scenario("Card purchase") { raw("You spent £12.45 at Tesco", FIXED_TIME) },
    Scenario("Incoming payment") { raw("Received £50.00 from Alex") },
    Scenario("Refund") { raw("Refund of £19.99 from Amazon") },
    Scenario("Cash withdrawal") { raw("Cash withdrawal £30.00 at ATM") },
    Scenario("Direct debit") { raw("Direct debit of £42.00 to British Gas") },
    Scenario("Transfer out") { raw("You sent £100.00 to Jane") },
    Scenario("Duplicate / reposted") { raw("You spent £12.45 at Tesco", FIXED_TIME) },
    Scenario("Unsupported notification") { raw("Your parcel is arriving today") },
)

/**
 * Feeds representative notifications through the REAL production pipeline
 * (listener sink → source filter → parser → Room → WorkManager → review),
 * bypassing nothing. Debug builds only.
 */
@Composable
private fun DebugSimulatorScreen() {
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf("Approve the simulated source first, then send a notification.") }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Text("Notification simulator (debug)", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(8.dp))
        Text(status, style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(16.dp))
        Button(
            onClick = {
                scope.launch {
                    container.sourceRepository.recordObserved(SIM_PKG, "Simulated Bank")
                    container.sourceRepository.setApproved(SIM_PKG, true)
                    status = "Simulated source approved. Now send a notification below."
                }
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Approve simulated source") }
        Spacer(Modifier.height(16.dp))
        scenarios.forEach { scenario ->
            OutlinedButton(
                onClick = {
                    scope.launch {
                        BankNotificationListenerService.sink?.onCaptured(scenario.build())
                        status = "Sent \"${scenario.label}\" — check Review imports, then Transactions after sync."
                    }
                },
                modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
            ) { Text(scenario.label) }
        }
    }
}
