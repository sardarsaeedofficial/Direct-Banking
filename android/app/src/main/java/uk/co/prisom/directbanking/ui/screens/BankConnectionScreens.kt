package uk.co.prisom.directbanking.ui.screens

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import uk.co.prisom.directbanking.data.remote.dto.BankConnectionDto
import uk.co.prisom.directbanking.data.remote.dto.ConnectedAccountDto
import uk.co.prisom.directbanking.ui.EmptyState
import uk.co.prisom.directbanking.ui.LoadingBox
import uk.co.prisom.directbanking.ui.MessageBox
import uk.co.prisom.directbanking.ui.money
import uk.co.prisom.directbanking.ui.vm.Async
import uk.co.prisom.directbanking.ui.vm.BankConnectionDetailViewModel
import uk.co.prisom.directbanking.ui.vm.BankConnectionsViewModel

/** Opens the provider's hosted authorization journey in the system browser (never an embedded/imitated login). */
@Composable
private fun LaunchAuthOnUrl(url: String?, onConsumed: () -> Unit) {
    val context = LocalContext.current
    LaunchedEffect(url) {
        url?.let {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(it)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            onConsumed()
        }
    }
}

@Composable
fun BankConnectionsScreen(vm: BankConnectionsViewModel, onOpen: (String) -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    val authUrl by vm.authUrl.collectAsStateWithLifecycle()
    val starting by vm.starting.collectAsStateWithLifecycle()
    LaunchAuthOnUrl(authUrl) { vm.consumedAuthUrl() }

    Column(Modifier.fillMaxSize()) {
        Text("Bank connections", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(16.dp))
        when (val s = state) {
            is Async.Loading -> LoadingBox()
            is Async.Failure -> MessageBox(s.message)
            is Async.Success -> {
                if (s.data.isEmpty()) {
                    EmptyState("No banks connected yet. Connect a bank to import transactions and balances directly.")
                } else {
                    LazyColumn(Modifier.weight(1f, fill = false).fillMaxWidth()) {
                        items(s.data, key = { it.id }) { ConnectionRow(it) { onOpen(it.id) } }
                    }
                }
                Column(Modifier.padding(16.dp)) {
                    Button(onClick = { vm.connectAnother() }, enabled = !starting, modifier = Modifier.fillMaxWidth()) {
                        Text(if (starting) "Starting…" else "+ Connect another bank")
                    }
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "You'll authenticate securely with your bank. Direct Banking never sees your bank username, password or PIN.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun ConnectionRow(c: BankConnectionDto, onClick: () -> Unit) {
    Column(Modifier.clickable(onClick = onClick)) {
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(c.institutionName ?: c.provider, style = MaterialTheme.typography.titleMedium)
                Text(statusText(c), style = MaterialTheme.typography.bodySmall, color = statusColor(c))
            }
        }
        HorizontalDivider()
    }
}

@Composable
fun BankConnectionDetailScreen(vm: BankConnectionDetailViewModel, onDisconnected: () -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    val authUrl by vm.authUrl.collectAsStateWithLifecycle()
    val message by vm.message.collectAsStateWithLifecycle()
    LaunchAuthOnUrl(authUrl) { vm.consumedAuthUrl() }

    when (val s = state) {
        is Async.Loading -> LoadingBox()
        is Async.Failure -> MessageBox(s.message)
        is Async.Success -> {
            val conn = s.data.connection
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
                Text(conn.institutionName ?: conn.provider, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Text(statusText(conn), color = statusColor(conn))
                Spacer(Modifier.height(12.dp))

                Text("Connected accounts", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(4.dp))
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp)) {
                        if (s.data.accounts.isEmpty()) Text("No accounts yet.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        s.data.accounts.forEach { AccountBlock(it) }
                    }
                }

                Spacer(Modifier.height(12.dp))
                Text("Data access & consent", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(4.dp))
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp)) {
                        Line("Provider", conn.provider)
                        Line("Data accessed", "Accounts, balances, transactions")
                        Line("Connected", conn.consentGrantedAt?.take(10))
                        Line("Consent expires", conn.consentExpiresAt?.take(10))
                        Line("Last successful sync", conn.lastSuccessfulSyncAt?.take(19)?.replace("T", " "))
                        conn.lastErrorCode?.let { Line("Last error", it) }
                    }
                }

                message?.let { Spacer(Modifier.height(8.dp)); Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary) }

                Spacer(Modifier.height(16.dp))
                Button(onClick = { vm.syncNow() }, modifier = Modifier.fillMaxWidth()) { Text("Sync now") }
                Spacer(Modifier.height(8.dp))
                OutlinedButton(onClick = { vm.reconnect() }, modifier = Modifier.fillMaxWidth()) { Text("Reconnect") }
                Spacer(Modifier.height(8.dp))
                OutlinedButton(onClick = { vm.disconnect(onDisconnected) }, modifier = Modifier.fillMaxWidth()) { Text("Disconnect (keeps history)") }
                Spacer(Modifier.height(24.dp))
            }
        }
    }
}

@Composable
private fun AccountBlock(a: ConnectedAccountDto) {
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Row(Modifier.fillMaxWidth()) {
            Text(a.nickname, Modifier.weight(1f), fontWeight = FontWeight.Medium)
            Text(money(a.balanceMinor, a.currency), fontWeight = FontWeight.SemiBold)
        }
        a.accountHolderName?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        Text(
            listOfNotNull(a.sortCodeMasked, a.accountNumberMasked, a.ibanMasked, if (a.balanceAuthority == "PROVIDER") "Bank balance" else null).joinToString(" · "),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        HorizontalDivider(Modifier.padding(top = 8.dp))
    }
}

@Composable
private fun Line(label: String, value: String?) {
    if (value.isNullOrBlank()) return
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(label, Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, fontWeight = FontWeight.Medium)
    }
}

private fun statusText(c: BankConnectionDto): String = when (c.status) {
    "ACTIVE" -> "✓ Connected" + (c.lastSuccessfulSyncAt?.let { " · synced ${it.take(10)}" } ?: "")
    "REAUTH_REQUIRED" -> "Reconnect required"
    "EXPIRED" -> "Consent expired — reconnect"
    "ERROR" -> "Needs attention"
    "AUTHORIZATION_REQUIRED", "PENDING" -> "Awaiting authorization"
    "REVOKED" -> "Disconnected"
    else -> c.status
}

@Composable
private fun statusColor(c: BankConnectionDto) = when (c.status) {
    "ACTIVE" -> MaterialTheme.colorScheme.primary
    "REAUTH_REQUIRED", "EXPIRED", "ERROR" -> MaterialTheme.colorScheme.error
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}
