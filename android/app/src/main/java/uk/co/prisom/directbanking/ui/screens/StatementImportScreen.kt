package uk.co.prisom.directbanking.ui.screens

import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import uk.co.prisom.directbanking.ui.EmptyState
import uk.co.prisom.directbanking.ui.LoadingBox
import uk.co.prisom.directbanking.ui.money
import uk.co.prisom.directbanking.ui.vm.ImportStage
import uk.co.prisom.directbanking.ui.vm.StatementImportViewModel

private fun fileTypeFor(name: String): String? = when (name.substringAfterLast('.', "").lowercase()) {
    "csv", "tsv", "txt" -> "CSV"
    "ofx", "qfx" -> "OFX"
    "qif" -> "QIF"
    "pdf" -> "PDF"
    else -> null
}

private fun displayName(context: android.content.Context, uri: Uri): String {
    var name = "statement"
    runCatching {
        context.contentResolver.query(uri, null, null, null, null)?.use { c ->
            val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (idx >= 0 && c.moveToFirst()) c.getString(idx)?.let { name = it }
        }
    }
    return name
}

@Composable
fun StatementImportScreen(vm: StatementImportViewModel, onDone: () -> Unit) {
    val stage by vm.stage.collectAsStateWithLifecycle()
    val context = LocalContext.current

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        val name = displayName(context, uri)
        val type = fileTypeFor(name)
        if (type == null) { vm.upload(name, "", "") /* server will reject with a clear message */; return@rememberLauncherForActivityResult }
        // Read bytes off the main thread is ideal; files here are small and bounded server-side.
        val bytes = runCatching { context.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull()
        if (bytes == null || bytes.isEmpty()) return@rememberLauncherForActivityResult
        vm.upload(name, type, Base64.encodeToString(bytes, Base64.NO_WRAP))
    }

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("Import bank statement", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(4.dp))
        Text(
            "For banks without notifications or Open Banking. Supported: CSV, OFX, QIF, and text-based PDF.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(16.dp))

        when (val s = stage) {
            ImportStage.PickFile -> PickFileStage(vm) { picker.launch(arrayOf("*/*")) }
            ImportStage.Uploading -> LoadingBox()
            is ImportStage.Preview -> PreviewStage(vm, s)
            ImportStage.Importing -> LoadingBox()
            is ImportStage.Result -> ResultStage(s, onDone) { vm.reset() }
            is ImportStage.Failed -> FailedStage(s.message) { vm.reset() }
        }
    }
}

@Composable
private fun PickFileStage(vm: StatementImportViewModel, onPick: () -> Unit) {
    val accounts by vm.accounts.collectAsStateWithLifecycle()
    val selected by vm.selectedAccountId.collectAsStateWithLifecycle()
    Text("1. Choose the account this statement belongs to", fontWeight = FontWeight.Medium)
    Spacer(Modifier.height(8.dp))
    if (accounts.isEmpty()) {
        EmptyState("Add an account first")
    } else {
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            accounts.forEach { a ->
                FilterChip(selected = a.id == selected, onClick = { vm.selectAccount(a.id) }, label = { Text("${a.nickname}${a.lastFour?.let { " ••$it" } ?: ""}") })
            }
        }
        Spacer(Modifier.height(20.dp))
        Text("2. Choose the statement file", fontWeight = FontWeight.Medium)
        Spacer(Modifier.height(8.dp))
        Button(onClick = onPick, enabled = selected != null, modifier = Modifier.fillMaxWidth()) { Text("Choose file…") }
    }
}

@Composable
private fun ColumnScope.PreviewStage(vm: StatementImportViewModel, stage: ImportStage.Preview) {
    val excluded by vm.excluded.collectAsStateWithLifecycle()
    val p = stage.preview
    Text("${p.summary.found} transactions found", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
    Text(
        "${p.summary.newCount} new · ${p.summary.duplicateCount} already recorded · ${p.summary.reviewCount} need review",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Spacer(Modifier.height(8.dp))
    Text("Untick any row to skip it before importing.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    LazyColumn(Modifier.fillMaxWidth().weight(1f).padding(top = 8.dp)) {
        items(p.rows, key = { it.id }) { row ->
            val isExcluded = excluded.contains(row.rowIndex)
            Card(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp)) {
                    Checkbox(checked = !isExcluded, onCheckedChange = { vm.toggleExclude(row.rowIndex) })
                    Column(Modifier.weight(1f)) {
                        Text(row.description, fontWeight = FontWeight.Medium, maxLines = 1)
                        Text(
                            "${row.bookedAt.take(10)} · ${row.reconStatus.lowercase()}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    val sign = if (row.direction == "INCOME") "+" else "-"
                    Text(sign + money(row.amountMinor, row.currency), fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
    Button(onClick = { vm.confirmImport() }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) {
        Text("Import ${p.rows.size - excluded.size} transactions")
    }
}

@Composable
private fun ResultStage(stage: ImportStage.Result, onDone: () -> Unit, onAnother: () -> Unit) {
    val r = stage.result
    Text("Import complete", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(8.dp))
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text("${r.total} statement rows")
            Text("${r.imported} new transactions")
            Text("${r.matched} matched existing transactions")
            Text("${r.duplicates} already recorded")
            if (r.skipped > 0) Text("${r.skipped} skipped")
            if (r.review > 0) Text("${r.review} sent to Review", color = MaterialTheme.colorScheme.primary)
        }
    }
    Spacer(Modifier.height(16.dp))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = onAnother, modifier = Modifier.weight(1f)) { Text("Import another") }
        Button(onClick = onDone, modifier = Modifier.weight(1f)) { Text("Done") }
    }
}

@Composable
private fun FailedStage(message: String, onRetry: () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text("Couldn't import that file", fontWeight = FontWeight.SemiBold)
            Text(message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    Spacer(Modifier.height(12.dp))
    Button(onClick = onRetry) { Text("Try another file") }
}
