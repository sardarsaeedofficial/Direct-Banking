package uk.co.prisom.directbanking.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import uk.co.prisom.directbanking.data.remote.dto.RecurringPaymentItemDto
import uk.co.prisom.directbanking.ui.EmptyState
import uk.co.prisom.directbanking.ui.LoadingBox
import uk.co.prisom.directbanking.ui.MessageBox
import uk.co.prisom.directbanking.ui.money
import uk.co.prisom.directbanking.ui.vm.Async
import uk.co.prisom.directbanking.ui.vm.PaymentsViewModel

private fun kindLabel(kind: String): String = when (kind) {
    "DIRECT_DEBIT" -> "Direct Debits"
    "SUBSCRIPTION" -> "Subscriptions"
    "RECURRING_CARD" -> "Recurring card payments"
    "STANDING_ORDER" -> "Standing orders"
    else -> kind
}

@Composable
fun PaymentsScreen(vm: PaymentsViewModel, onOpen: (String) -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    val suggestions by vm.suggestions.collectAsStateWithLifecycle()

    when (val s = state) {
        is Async.Loading -> LoadingBox()
        is Async.Failure -> MessageBox(s.message)
        is Async.Success -> {
            val view = s.data
            LazyColumn(Modifier.fillMaxWidth()) {
                item {
                    Card(Modifier.fillMaxWidth().padding(12.dp)) {
                        Column(Modifier.padding(16.dp)) {
                            Text("Recurring payments", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                            Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("Monthly", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Text(money(view.monthlyTotalMinor), fontWeight = FontWeight.Bold)
                            }
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("Annual", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Text(money(view.annualTotalMinor), fontWeight = FontWeight.Medium)
                            }
                            Text("${view.activeCount} active", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                if (view.items.isEmpty()) item { EmptyState("No recurring payments detected yet") }

                // Group by canonical kind.
                view.byKind.forEach { (kind, items) ->
                    item {
                        Text(
                            kindLabel(kind),
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.padding(start = 16.dp, top = 12.dp, bottom = 4.dp),
                        )
                    }
                    items(items.size) { i -> RecurringRow(items[i], onOpen) }
                }

                if (suggestions.isNotEmpty()) {
                    item {
                        Text(
                            "Possible subscriptions (review)",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 4.dp),
                        )
                    }
                    items(suggestions.size) { i ->
                        val g = suggestions[i]
                        Card(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
                            Row(Modifier.fillMaxWidth().padding(14.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                                Column {
                                    Text(g.merchantName, fontWeight = FontWeight.Medium)
                                    Text("${g.occurrences} charges · ~every ${g.medianIntervalDays} days · ${g.confidence.lowercase()}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                Text(money(g.averageAmountMinor), fontWeight = FontWeight.SemiBold)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RecurringRow(item: RecurringPaymentItemDto, onOpen: (String) -> Unit) {
    Card(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).clickable { onOpen(item.id) },
    ) {
        Row(
            Modifier.fillMaxWidth().padding(14.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column {
                Text(item.companyName, fontWeight = FontWeight.Medium)
                Text(
                    item.nextExpectedIso?.let { "Next: ${it.take(10)}" } ?: "${item.paymentCount} payments",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(money(item.expectedAmountMinor, item.currency), fontWeight = FontWeight.SemiBold)
        }
    }
}
