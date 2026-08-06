package uk.co.prisom.directbanking.ui.screens

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
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import uk.co.prisom.directbanking.R
import uk.co.prisom.directbanking.data.local.db.SourceWithCount
import uk.co.prisom.directbanking.notifications.NotificationAccess
import uk.co.prisom.directbanking.ui.EmptyState
import uk.co.prisom.directbanking.ui.vm.SourcesViewModel
import java.text.DateFormat
import java.util.Date

/** Live notification-listener access state, refreshed whenever the screen resumes. */
@Composable
fun rememberNotificationAccessState(): State<Boolean> {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val state = remember { mutableStateOf(NotificationAccess.isEnabled(context)) }
    DisposableEffect(owner) {
        val obs = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) state.value = NotificationAccess.isEnabled(context)
        }
        owner.lifecycle.addObserver(obs)
        onDispose { owner.lifecycle.removeObserver(obs) }
    }
    return state
}

@Composable
fun DisclosureScreen(vm: SourcesViewModel, onAgree: () -> Unit, onDecline: () -> Unit) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(stringResource(R.string.disclosure_title), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(16.dp))
        Text(stringResource(R.string.disclosure_body), style = MaterialTheme.typography.bodyLarge)
        Spacer(Modifier.height(28.dp))
        Button(
            onClick = { vm.acceptDisclosure(); onAgree() },
            modifier = Modifier.fillMaxWidth(),
        ) { Text(stringResource(R.string.disclosure_agree)) }
        Spacer(Modifier.height(8.dp))
        OutlinedButton(
            onClick = { vm.declineDisclosure(); onDecline() },
            modifier = Modifier.fillMaxWidth(),
        ) { Text(stringResource(R.string.disclosure_decline)) }
    }
}

@Composable
fun NotificationAccessScreen(onManageSources: () -> Unit) {
    val context = LocalContext.current
    val enabled by rememberNotificationAccessState()
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
    ) {
        Text("Notification access", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(12.dp))
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text(
                    if (enabled) "Access granted" else "Access not granted",
                    style = MaterialTheme.typography.titleMedium,
                    color = if (enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    "Notification access lets Direct Banking read notifications from the financial apps you approve. It is separate from permission to send you reminders.",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
        Spacer(Modifier.height(16.dp))
        Button(
            onClick = { context.startActivity(NotificationAccess.settingsIntent()) },
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (enabled) "Open notification access settings" else "Grant notification access") }
        Spacer(Modifier.height(8.dp))
        OutlinedButton(onClick = onManageSources, modifier = Modifier.fillMaxWidth()) { Text("Manage approved sources") }
    }
}

@Composable
fun ApprovedSourcesScreen(vm: SourcesViewModel) {
    val sources by vm.sources.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxSize()) {
        Text("Approved notification sources", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(16.dp))
        if (sources.isEmpty()) {
            EmptyState("No notification sources observed yet. Once a financial app posts a notification while access is granted, it will appear here for you to approve.")
        } else {
            LazyColumn(Modifier.fillMaxSize()) {
                items(sources, key = { it.packageName }) { s -> SourceRow(s, vm) }
            }
        }
    }
}

@Composable
private fun SourceRow(s: SourceWithCount, vm: SourcesViewModel) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(s.label.ifBlank { s.packageName }, style = MaterialTheme.typography.titleMedium)
                Text(s.packageName, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    "Last seen ${DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(s.lastSeenMillis))} · ${s.importedCount} imported",
                    style = MaterialTheme.typography.bodySmall,
                )
                if (s.ignored) Text("Ignored", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error)
            }
            Switch(checked = s.approved, onCheckedChange = { vm.setApproved(s.packageName, it) })
        }
        if (!s.ignored) {
            TextButton(onClick = { vm.ignore(s.packageName) }) { Text("Permanently ignore") }
        }
        HorizontalDivider()
    }
}
