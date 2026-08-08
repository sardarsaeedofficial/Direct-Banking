package uk.co.prisom.directbanking.ui.screens

import android.widget.Toast
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import uk.co.prisom.directbanking.notifications.NotificationAccess
import uk.co.prisom.directbanking.parsing.Money
import uk.co.prisom.directbanking.ui.vm.DiagnosticsViewModel
import java.text.DateFormat
import java.util.Date

@Composable
fun DiagnosticsScreen(vm: DiagnosticsViewModel) {
    val context = LocalContext.current
    val snap by vm.snapshot.collectAsStateWithLifecycle()
    val accessGranted = NotificationAccess.isEnabled(context)

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Text("Notification diagnostics", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(12.dp))

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Row2("Notification access", if (accessGranted) "granted" else "not granted")
                Row2("Listener connected", if (snap.listenerConnected) "yes" else "no")
            }
        }
        Spacer(Modifier.height(12.dp))

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text("Last notification", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(8.dp))
                Row2("Package", snap.lastPackage ?: "—")
                Row2("Source", snap.lastLabel ?: "—")
                Row2("Time", snap.lastReceivedAtMillis?.let { DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(it)) } ?: "—")
                Row2("Title (redacted)", snap.lastRedactedTitle ?: "—")
                Row2("Text (redacted)", snap.lastRedactedText ?: "—")
                HorizontalDivider(Modifier.padding(vertical = 4.dp))
                Row2("Trust level", snap.trustLevel ?: "—")
                Row2("Built-in trusted", if (snap.builtInTrusted) "yes" else "no")
                Row2("Signature checked", if (snap.signatureChecked) "yes" else "no")
                Row2(
                    "Signature matched",
                    when (snap.signatureMatched) {
                        true -> "yes"
                        false -> "no"
                        null -> "not configured"
                    },
                )
                Row2("Signing SHA-256", snap.signingSha256Abbrev ?: "—")
                Row2("Source trusted/approved", if (snap.sourceTrustedOrApproved) "yes" else "no")
                Row2("Auto-import enabled", if (snap.autoImportEnabled) "yes" else "no")
                Row2("Linked account", snap.linkedAccountId ?: "not mapped")
                Row2("Parsed amount", snap.parsedAmountMinor?.let { Money.format(it, snap.parsedCurrency ?: "GBP") } ?: "—")
                Row2("Parsed direction", snap.parsedDirection ?: "—")
                Row2("Parsed currency", snap.parsedCurrency ?: "—")
                Row2("Confidence", snap.confidence?.let { "${(it * 100).toInt()}%" } ?: "—")
                Row2("Import result", snap.importResult ?: "—")
                Row2("Transaction ID", snap.transactionId ?: "—")
                Row2("Failure reason", snap.failureReason ?: "—")
            }
        }
        Spacer(Modifier.height(16.dp))

        Button(
            onClick = {
                val ok = vm.scanVisibleNotifications()
                Toast.makeText(
                    context,
                    if (ok) "Scanning currently visible notifications…" else "Notification listener isn't connected",
                    Toast.LENGTH_SHORT,
                ).show()
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Scan currently visible notifications") }
        Spacer(Modifier.height(8.dp))
        Text(
            "Only scans notifications currently in your shade, on demand. It never silently scans history.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun Row2(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(label, modifier = Modifier.padding(end = 8.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, modifier = Modifier.weight(1f), textAlign = TextAlign.End)
    }
    HorizontalDivider()
}
