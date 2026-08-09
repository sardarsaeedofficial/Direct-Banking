package uk.co.prisom.directbanking.ui.screens

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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import uk.co.prisom.directbanking.data.remote.dto.DdHistoryItemDto
import uk.co.prisom.directbanking.data.remote.dto.DdStatsDto
import uk.co.prisom.directbanking.data.remote.dto.DdUpdateRequest
import uk.co.prisom.directbanking.data.remote.dto.DirectDebitMandateDto
import uk.co.prisom.directbanking.ui.EmptyState
import uk.co.prisom.directbanking.ui.LoadingBox
import uk.co.prisom.directbanking.ui.MessageBox
import uk.co.prisom.directbanking.ui.money
import uk.co.prisom.directbanking.ui.vm.Async
import uk.co.prisom.directbanking.ui.vm.DdSort
import uk.co.prisom.directbanking.ui.vm.DdTab
import uk.co.prisom.directbanking.ui.vm.DirectDebitDetailViewModel
import uk.co.prisom.directbanking.ui.vm.DirectDebitsViewModel

@Composable
fun DirectDebitsScreen(vm: DirectDebitsViewModel, onOpen: (String) -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    val tab by vm.tab.collectAsStateWithLifecycle()
    val query by vm.query.collectAsStateWithLifecycle()
    val sort by vm.sort.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize()) {
        Text("Direct Debits", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(16.dp))
        LazyRow(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(DdTab.entries.toList(), key = { it.name }) { t ->
                FilterChip(selected = tab == t, onClick = { vm.setTab(t) }, label = { Text(t.label) })
            }
        }
        Spacer(Modifier.height(8.dp))
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = query, onValueChange = vm::setQuery, singleLine = true,
                modifier = Modifier.weight(1f), placeholder = { Text("Search company") },
            )
            SortMenu(sort) { vm.setSort(it) }
        }
        Spacer(Modifier.height(8.dp))

        when (val s = state) {
            is Async.Loading -> LoadingBox()
            is Async.Failure -> MessageBox(s.message)
            is Async.Success -> if (s.data.isEmpty()) EmptyState("No Direct Debits in this view.") else LazyColumn(Modifier.fillMaxSize()) {
                items(s.data, key = { it.id }) { MandateRow(it) { onOpen(it.id) } }
            }
        }
    }
}

@Composable
private fun SortMenu(current: DdSort, onPick: (DdSort) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Column {
        OutlinedButton(onClick = { expanded = true }) { Text("Sort") }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            DdSort.entries.forEach { s ->
                DropdownMenuItem(text = { Text(s.label + if (s == current) " ✓" else "") }, onClick = { onPick(s); expanded = false })
            }
        }
    }
}

@Composable
private fun MandateRow(m: DirectDebitMandateDto, onClick: () -> Unit) {
    Column(Modifier.clickable(onClick = onClick)) {
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(m.companyName, style = MaterialTheme.typography.titleMedium)
                Text(
                    listOfNotNull(m.nextExpectedAt?.take(10)?.let { "Next $it" }, m.account?.nickname, m.status.takeIf { it != "ACTIVE" }).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            val approx = m.expectationMode == "RANGE"
            Text((if (approx) "~" else "") + money(m.effectiveAmountMinor ?: m.lastAmountMinor ?: 0, "GBP"), fontWeight = FontWeight.SemiBold)
        }
        HorizontalDivider()
    }
}

@Composable
fun DirectDebitDetailScreen(vm: DirectDebitDetailViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    when (val s = state) {
        is Async.Loading -> LoadingBox()
        is Async.Failure -> MessageBox(s.message)
        is Async.Success -> DetailBody(s.data.mandate, s.data.stats, s.data.history, vm)
    }
}

@Composable
private fun DetailBody(m: DirectDebitMandateDto, stats: DdStatsDto, history: List<DdHistoryItemDto>, vm: DirectDebitDetailViewModel) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Text(m.companyName, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        AssistChip(onClick = {}, label = { Text(statusLabel(m.status) + " Direct Debit") })
        m.account?.let { Text("Paid from: ${it.nickname}", style = MaterialTheme.typography.bodyMedium) }
        Spacer(Modifier.height(12.dp))

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                DetailLine("Next expected", listOfNotNull(m.nextExpectedAt?.take(10), m.effectiveAmountMinor?.let { "~" + money(it, "GBP") }).joinToString(" · ").ifBlank { null })
                if (m.expectationMode == "RANGE" && m.effectiveMinMinor != null && m.effectiveMaxMinor != null) {
                    DetailLine("Expected range", "${money(m.effectiveMinMinor, "GBP")} – ${money(m.effectiveMaxMinor, "GBP")}")
                }
                DetailLine("Paid this month", money(stats.paidThisMonthMinor, "GBP"))
                DetailLine("Paid this year", money(stats.paidThisYearMinor, "GBP"))
                DetailLine("Average payment", money(stats.averageMinor, "GBP"))
                DetailLine("Median payment", money(stats.medianMinor, "GBP"))
                DetailLine("Highest payment", money(stats.highestMinor, "GBP"))
                DetailLine("Lowest payment", money(stats.lowestMinor, "GBP"))
                DetailLine("Frequency", m.frequency.lowercase().replaceFirstChar { it.uppercase() })
            }
        }

        Spacer(Modifier.height(16.dp))
        Text("Payment history", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(4.dp))
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(horizontal = 16.dp)) {
                if (history.isEmpty()) {
                    Text("No payments yet.", Modifier.padding(vertical = 12.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                history.forEach { h ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(h.bookedAt?.take(10) ?: "—", Modifier.weight(1f))
                        h.ddAnomaly?.takeIf { it != "NORMAL" && it != "FIRST_PAYMENT" }?.let {
                            Text(anomalyLabel(it), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(end = 8.dp))
                        }
                        Text(money(h.amountMinor, h.currency), fontWeight = FontWeight.SemiBold)
                    }
                    HorizontalDivider()
                }
            }
        }

        Spacer(Modifier.height(16.dp))
        EditSection(m, vm)
    }
}

@Composable
private fun EditSection(m: DirectDebitMandateDto, vm: DirectDebitDetailViewModel) {
    var name by remember(m.id) { mutableStateOf(m.companyName) }
    var amount by remember(m.id) { mutableStateOf(m.effectiveAmountMinor?.let { (it / 100.0).toString() } ?: "") }
    var notes by remember(m.id) { mutableStateOf(m.notes ?: "") }
    var status by remember(m.id) { mutableStateOf(m.status) }

    Text("Edit", style = MaterialTheme.typography.titleMedium)
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(name, { name = it }, label = { Text("Company name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(amount, { amount = it }, label = { Text("Expected amount (£)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(notes, { notes = it }, label = { Text("Notes") }, modifier = Modifier.fillMaxWidth())
    Spacer(Modifier.height(8.dp))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        StatusMenu(status) { status = it }
        Button(
            onClick = {
                val minor = amount.toDoubleOrNull()?.let { (it * 100).toLong() }
                vm.update(
                    DdUpdateRequest(
                        companyName = name.takeIf { it.isNotBlank() && it != m.companyName },
                        userExpectedAmountMinor = minor,
                        expectationMode = if (minor != null) "FIXED" else null,
                        notes = notes.takeIf { it != (m.notes ?: "") },
                        status = status.takeIf { it != m.status },
                    ),
                )
            },
            modifier = Modifier.weight(1f),
        ) { Text("Save changes") }
    }
    Spacer(Modifier.height(24.dp))
}

@Composable
private fun StatusMenu(current: String, onPick: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Column {
        OutlinedButton(onClick = { expanded = true }) { Text(statusLabel(current)) }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            listOf("ACTIVE", "PAUSED", "CANCELLED").forEach { s ->
                DropdownMenuItem(text = { Text(statusLabel(s)) }, onClick = { onPick(s); expanded = false })
            }
        }
    }
}

@Composable
private fun DetailLine(label: String, value: String?) {
    if (value.isNullOrBlank()) return
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(label, Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, fontWeight = FontWeight.Medium)
    }
}

private fun statusLabel(s: String) = when (s) {
    "ACTIVE" -> "Active"
    "PAUSED" -> "Paused"
    "CANCELLED" -> "Cancelled"
    else -> "Unknown"
}
private fun anomalyLabel(a: String) = when (a) {
    "ABOVE_EXPECTED" -> "Higher"
    "BELOW_EXPECTED" -> "Lower"
    "UNEXPECTED_DATE" -> "Off-date"
    else -> a
}
