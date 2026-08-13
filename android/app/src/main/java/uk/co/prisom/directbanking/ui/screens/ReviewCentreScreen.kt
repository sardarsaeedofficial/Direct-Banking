package uk.co.prisom.directbanking.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import uk.co.prisom.directbanking.data.remote.dto.ReviewDupPair
import uk.co.prisom.directbanking.data.remote.dto.ReviewTxnBrief
import uk.co.prisom.directbanking.ui.EmptyState
import uk.co.prisom.directbanking.ui.LoadingBox
import uk.co.prisom.directbanking.ui.MessageBox
import uk.co.prisom.directbanking.ui.money
import uk.co.prisom.directbanking.ui.vm.Async
import uk.co.prisom.directbanking.ui.vm.ReviewCentreViewModel

private fun minor(s: String): Long = s.toLongOrNull() ?: 0L
private fun signed(b: ReviewTxnBrief): String = (if (b.direction == "INCOME") "+" else "-") + money(minor(b.amountMinor), b.currency)

@Composable
fun ReviewCentreScreen(vm: ReviewCentreViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    val message by vm.message.collectAsStateWithLifecycle()
    var pairFor by remember { mutableStateOf<ReviewTxnBrief?>(null) }

    when (val s = state) {
        is Async.Loading -> LoadingBox()
        is Async.Failure -> MessageBox(s.message)
        is Async.Success -> {
            val d = s.data
            val nothing = d.counts.possibleDuplicates + d.counts.uncertainStatementMatches +
                d.counts.possibleInternalTransfers + d.counts.possibleSubscriptions + d.counts.uncategorized == 0
            LazyColumn(Modifier.fillMaxWidth()) {
                item {
                    Text("Review", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, modifier = Modifier.padding(16.dp))
                    message?.let {
                        Text(it, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp))
                    }
                }
                if (nothing) item { EmptyState("Nothing to review — you're all caught up.") }

                dupSection("Possible duplicates", d.possibleDuplicates, vm)
                dupSection("Uncertain statement matches", d.uncertainStatementMatches, vm)

                if (d.possibleInternalTransfers.isNotEmpty()) {
                    item { SectionTitle("Possible internal transfers") }
                    items(d.possibleInternalTransfers, key = { it.id }) { t ->
                        Card(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
                            Column(Modifier.padding(14.dp)) {
                                BriefRow(t)
                                Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    OutlinedButton(onClick = { pairFor = t }) { Text("Pair as transfer") }
                                    OutlinedButton(onClick = { vm.unpair(t.id) }) { Text("Unpair") }
                                }
                            }
                        }
                    }
                }

                if (d.possibleSubscriptions.isNotEmpty()) {
                    item { SectionTitle("Possible subscriptions") }
                    items(d.possibleSubscriptions, key = { it.merchantId }) { s ->
                        Card(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
                            Row(Modifier.fillMaxWidth().padding(14.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                                Column {
                                    Text(s.merchantName, fontWeight = FontWeight.Medium)
                                    Text("${s.occurrences} charges · ~every ${s.intervalDays} days · ${s.confidence.lowercase()}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                Text(money(minor(s.averageAmountMinor)), fontWeight = FontWeight.SemiBold)
                            }
                        }
                    }
                }

                if (d.uncategorized.isNotEmpty()) {
                    item { SectionTitle("Uncategorized") }
                    items(d.uncategorized, key = { it.id }) { t ->
                        Card(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
                            Column(Modifier.padding(14.dp)) { BriefRow(t) }
                        }
                    }
                }
            }
        }
    }

    // Manual pairing dialog: pick the opposite side from the other possible transfers.
    val current = state
    if (pairFor != null && current is Async.Success) {
        val src = pairFor!!
        val candidates = current.data.possibleInternalTransfers.filter { it.id != src.id && it.direction != src.direction }
        AlertDialog(
            onDismissRequest = { pairFor = null },
            title = { Text("Pair with the other side") },
            text = {
                Column {
                    Text("${src.description} · ${signed(src)}", fontWeight = FontWeight.Medium)
                    if (candidates.isEmpty()) {
                        Text("No opposite transaction available to pair with.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    } else {
                        candidates.forEach { c ->
                            TextButton(onClick = { vm.pair(src.id, c.id); pairFor = null }) {
                                Text("${c.description} · ${signed(c)}")
                            }
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { pairFor = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun SectionTitle(title: String) {
    Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 16.dp, top = 14.dp, bottom = 4.dp))
}

@Composable
private fun BriefRow(t: ReviewTxnBrief) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Column(Modifier.padding(end = 8.dp)) {
            Text(t.merchantName ?: t.description, fontWeight = FontWeight.Medium, maxLines = 1)
            Text(
                listOfNotNull(t.accountName, t.bookedAt?.take(10), t.source.lowercase()).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(signed(t), fontWeight = FontWeight.SemiBold)
    }
}

// Extension to add a duplicate-pair section to a LazyColumn.
private fun androidx.compose.foundation.lazy.LazyListScope.dupSection(
    title: String,
    pairs: List<ReviewDupPair>,
    vm: ReviewCentreViewModel,
) {
    if (pairs.isEmpty()) return
    item { SectionTitle(title) }
    items(pairs, key = { it.transaction.id }) { pair ->
        Card(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
            Column(Modifier.padding(14.dp)) {
                Text("Possible match", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                BriefRow(pair.match)
                Text("vs", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 2.dp))
                BriefRow(pair.transaction)
                Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { vm.merge(pair.transaction.id) }) { Text("Merge") }
                    OutlinedButton(onClick = { vm.keepSeparate(pair.transaction.id) }) { Text("Keep separate") }
                }
            }
        }
    }
}
