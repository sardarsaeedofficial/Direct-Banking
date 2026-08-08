package uk.co.prisom.directbanking.ui.screens

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import uk.co.prisom.directbanking.domain.AccountSummary
import uk.co.prisom.directbanking.domain.DirectDebitSummary
import uk.co.prisom.directbanking.domain.TransactionSummary
import uk.co.prisom.directbanking.ui.EmptyState
import uk.co.prisom.directbanking.ui.LoadingBox
import uk.co.prisom.directbanking.ui.MessageBox
import uk.co.prisom.directbanking.ui.money
import uk.co.prisom.directbanking.ui.session.SessionViewModel
import uk.co.prisom.directbanking.ui.theme.DirectBankingColors
import uk.co.prisom.directbanking.ui.vm.Async
import uk.co.prisom.directbanking.ui.vm.DashboardViewModel
import uk.co.prisom.directbanking.ui.vm.OverviewViewModel
import uk.co.prisom.directbanking.ui.vm.SettingsViewModel
import uk.co.prisom.directbanking.ui.vm.SyncViewModel
import uk.co.prisom.directbanking.ui.vm.TransactionsViewModel
import java.text.DateFormat
import java.util.Date

@Composable
private fun StatCard(label: String, value: String, modifier: Modifier = Modifier) {
    Card(modifier) {
        Column(Modifier.padding(16.dp)) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(4.dp))
            Text(value, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
fun DashboardScreen(
    dashboard: DashboardViewModel,
    sync: SyncViewModel,
    onAccounts: () -> Unit = {},
    onDirectDebits: () -> Unit = {},
    onSync: () -> Unit = {},
    onNotifications: () -> Unit = {},
) {
    val state by dashboard.state.collectAsStateWithLifecycle()
    val pending by sync.pendingCount.collectAsStateWithLifecycle()
    val lastSync by sync.lastSyncAtMillis.collectAsStateWithLifecycle()
    when (val s = state) {
        is Async.Loading -> LoadingBox()
        is Async.Failure -> MessageBox(s.message)
        is Async.Success -> {
            val d = s.data
            val cur = d.baseCurrency
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
                Text("Hello${d.displayName?.let { ", $it" } ?: ""}", style = MaterialTheme.typography.headlineSmall)
                Spacer(Modifier.height(12.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    StatCard("Total balance", money(d.summary.totalBalanceMinor, cur), Modifier.weight(1f))
                    StatCard("Safe to spend", money(d.summary.safeToSpendMinor, cur), Modifier.weight(1f))
                }
                Spacer(Modifier.height(12.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    StatCard("Income this month", money(d.summary.incomeMinor, cur), Modifier.weight(1f))
                    StatCard("Spent this month", money(d.summary.expenseMinor, cur), Modifier.weight(1f))
                }
                Spacer(Modifier.height(12.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    StatCard("Upcoming direct debits", money(d.summary.remainingDirectDebitsMinor, cur), Modifier.weight(1f))
                    StatCard("Pending imports", pending.toString(), Modifier.weight(1f))
                }
                Spacer(Modifier.height(16.dp))
                Text(
                    "Last sync: " + if (lastSync > 0) DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(lastSync)) else "never",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(16.dp))
                Text("More", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(8.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = onAccounts, modifier = Modifier.weight(1f)) { Text("Accounts") }
                    OutlinedButton(onClick = onDirectDebits, modifier = Modifier.weight(1f)) { Text("Direct debits") }
                }
                Spacer(Modifier.height(8.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = onSync, modifier = Modifier.weight(1f)) { Text("Sync status") }
                    OutlinedButton(onClick = onNotifications, modifier = Modifier.weight(1f)) { Text("Notifications") }
                }
                Spacer(Modifier.height(12.dp))
                OutlinedButton(onClick = { dashboard.refresh() }) { Text("Refresh") }
            }
        }
    }
}

@Composable
fun AccountsScreen(vm: OverviewViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    when (val s = state) {
        is Async.Loading -> LoadingBox()
        is Async.Failure -> MessageBox(s.message)
        is Async.Success -> if (s.data.accounts.isEmpty()) EmptyState("No accounts.") else LazyColumn(Modifier.fillMaxSize()) {
            items(s.data.accounts, key = { it.id }) { AccountRow(it) }
        }
    }
}

@Composable
private fun AccountRow(a: AccountSummary) {
    Column {
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(a.nickname, style = MaterialTheme.typography.titleMedium)
                Text(listOfNotNull(a.bankName, a.lastFour?.let { "•••• $it" }).joinToString(" "), style = MaterialTheme.typography.bodySmall)
            }
            Text(money(a.balanceMinor, a.currency), fontWeight = FontWeight.SemiBold)
        }
        HorizontalDivider()
    }
}

@Composable
fun DirectDebitsScreen(vm: OverviewViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    when (val s = state) {
        is Async.Loading -> LoadingBox()
        is Async.Failure -> MessageBox(s.message)
        is Async.Success -> if (s.data.directDebits.isEmpty()) EmptyState("No upcoming direct debits.") else LazyColumn(Modifier.fillMaxSize()) {
            items(s.data.directDebits, key = { it.id }) { DirectDebitRow(it) }
        }
    }
}

@Composable
private fun DirectDebitRow(dd: DirectDebitSummary) {
    Column {
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(dd.merchantName, style = MaterialTheme.typography.titleMedium)
                dd.nextDueDate?.let { Text("Due ${it.take(10)}", style = MaterialTheme.typography.bodySmall) }
            }
            Text(money(dd.expectedAmountMinor, dd.currency), fontWeight = FontWeight.SemiBold)
        }
        HorizontalDivider()
    }
}

@Composable
fun NotificationsScreen() {
    val context = LocalContext.current
    val granted = Build.VERSION.SDK_INT < 33 ||
        androidx.core.content.ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Text("App notifications", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(8.dp))
        Text(
            "Direct Banking sends its own reminders and \"transaction needs review\" alerts. This is separate from notification access, which is what lets the app read notifications from approved banking apps.",
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(16.dp))
        Text(if (granted) "Reminders: enabled" else "Reminders: not enabled", style = MaterialTheme.typography.titleMedium)
        if (!granted && Build.VERSION.SDK_INT >= 33) {
            Spacer(Modifier.height(8.dp))
            Button(onClick = { launcher.launch(Manifest.permission.POST_NOTIFICATIONS) }) { Text("Enable reminders") }
        }
    }
}

@Composable
fun SyncStatusScreen(vm: SyncViewModel) {
    val pending by vm.pendingCount.collectAsStateWithLifecycle()
    val lastSync by vm.lastSyncAtMillis.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("Sync status", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(12.dp))
        StatCard("Pending uploads", pending.toString(), Modifier.fillMaxWidth())
        Spacer(Modifier.height(12.dp))
        StatCard(
            "Last successful sync",
            if (lastSync > 0) DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(lastSync)) else "never",
            Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(16.dp))
        Button(onClick = { vm.syncNow() }) { Text("Sync now") }
    }
}

@Composable
fun SettingsScreen(
    session: SessionViewModel,
    settings: SettingsViewModel,
    onManageSources: () -> Unit,
    onNotificationAccess: () -> Unit,
    onDiagnostics: () -> Unit,
    debugRoute: String?,
    onOpenDebug: () -> Unit,
) {
    val context = LocalContext.current
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Text("Settings & privacy", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(16.dp))
        OutlinedButton(onClick = onManageSources, modifier = Modifier.fillMaxWidth()) { Text("Approved notification sources") }
        Spacer(Modifier.height(8.dp))
        OutlinedButton(onClick = onNotificationAccess, modifier = Modifier.fillMaxWidth()) { Text("Notification access") }
        Spacer(Modifier.height(8.dp))
        OutlinedButton(onClick = onDiagnostics, modifier = Modifier.fillMaxWidth()) { Text("Notification diagnostics") }
        Spacer(Modifier.height(8.dp))
        OutlinedButton(onClick = { settings.deleteLocalData() }, modifier = Modifier.fillMaxWidth()) { Text("Delete captured local data") }
        Spacer(Modifier.height(8.dp))
        OutlinedButton(
            onClick = {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://direct-banking.doorstepmanchester.uk/privacy")))
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Privacy policy") }
        if (debugRoute != null) {
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = onOpenDebug, modifier = Modifier.fillMaxWidth()) { Text("Debug: notification simulator") }
        }
        Spacer(Modifier.height(24.dp))
        Button(onClick = { session.logout() }, modifier = Modifier.fillMaxWidth()) { Text("Log out") }
        Spacer(Modifier.height(8.dp))
        OutlinedButton(onClick = { settings.revokeThisDevice { session.logout() } }, modifier = Modifier.fillMaxWidth()) {
            Text("Revoke this device")
        }
    }
}
