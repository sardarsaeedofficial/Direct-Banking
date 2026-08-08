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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.clickable
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import uk.co.prisom.directbanking.domain.AccountSummary
import uk.co.prisom.directbanking.domain.TransactionSummary
import uk.co.prisom.directbanking.ui.EmptyState
import uk.co.prisom.directbanking.ui.LoadingBox
import uk.co.prisom.directbanking.ui.MessageBox
import uk.co.prisom.directbanking.ui.money
import uk.co.prisom.directbanking.ui.theme.DirectBankingColors
import uk.co.prisom.directbanking.ui.vm.ActivityFilter
import uk.co.prisom.directbanking.ui.vm.Async
import uk.co.prisom.directbanking.ui.vm.TransactionsViewModel

@Composable
fun TransactionsScreen(vm: TransactionsViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    val filter by vm.filter.collectAsStateWithLifecycle()
    val query by vm.query.collectAsStateWithLifecycle()
    val accounts by vm.accounts.collectAsStateWithLifecycle()
    val selected by vm.selected.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize()) {
        LazyRow(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(ActivityFilter.entries.toList(), key = { it.name }) { f ->
                FilterChip(selected = filter == f, onClick = { vm.setFilter(f) }, label = { Text(f.label) })
            }
        }
        OutlinedTextField(
            value = query,
            onValueChange = vm::setQuery,
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
            placeholder = { Text("Search merchant, sender, reference, amount…") },
        )
        Spacer(Modifier.height(8.dp))

        when (val s = state) {
            is Async.Loading -> LoadingBox()
            is Async.Failure -> MessageBox(s.message)
            is Async.Success -> if (s.data.isEmpty()) {
                EmptyState("No transactions match this view.")
            } else {
                LazyColumn(Modifier.fillMaxSize()) {
                    items(s.data, key = { it.id }) { ActivityRow(it) { vm.open(it) } }
                }
            }
        }
    }

    selected?.let { txn ->
        TransactionDetailDialog(txn, accounts, onDismiss = vm::close, vm = vm)
    }
}

@Composable
private fun ActivityRow(t: TransactionSummary, onClick: () -> Unit) {
    val income = t.direction == "INCOME"
    Column(Modifier.clickable(onClick = onClick)) {
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(t.description, style = MaterialTheme.typography.titleMedium)
                Text(
                    listOfNotNull(subtitleType(t), t.category, t.account, t.bookedAt?.take(10)).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (t.isInternalTransfer) {
                Text(money(t.amountMinor, t.currency), fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                Text(
                    (if (income) "+" else "-") + money(t.amountMinor, t.currency),
                    color = if (income) DirectBankingColors.income else DirectBankingColors.expense,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
        HorizontalDivider()
    }
}

private fun subtitleType(t: TransactionSummary): String? = when {
    t.isInternalTransfer -> "Internal transfer"
    t.isPossibleTransfer -> "Possible transfer"
    t.transactionType == "DIRECT_DEBIT" -> "Direct debit"
    t.transactionType == "REFUND" -> "Refund"
    else -> null
}

@Composable
private fun TransactionDetailDialog(
    t: TransactionSummary,
    accounts: List<AccountSummary>,
    onDismiss: () -> Unit,
    vm: TransactionsViewModel,
) {
    Dialog(onDismissRequest = onDismiss) {
        Card {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp)) {
                Text(t.description, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(4.dp))
                val income = t.direction == "INCOME"
                Text(
                    (if (t.isInternalTransfer) "" else if (income) "+" else "-") + money(t.amountMinor, t.currency),
                    style = MaterialTheme.typography.headlineSmall,
                    color = when {
                        t.isInternalTransfer -> MaterialTheme.colorScheme.onSurface
                        income -> DirectBankingColors.income
                        else -> DirectBankingColors.expense
                    },
                )

                if (t.isInternalTransfer) {
                    Spacer(Modifier.height(8.dp))
                    AssistChip(onClick = {}, label = { Text("Internal transfer") })
                    transferRoute(t)?.let { Text(it, style = MaterialTheme.typography.titleMedium) }
                    Text("Excluded from income and spending", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
                } else if (t.isPossibleTransfer) {
                    Spacer(Modifier.height(8.dp))
                    Text("Looks like a transfer between your accounts", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
                }

                Spacer(Modifier.height(12.dp))
                HorizontalDivider()
                DetailRow("Type", prettyType(t.transactionType) ?: t.direction)
                DetailRow("Status", t.status)
                DetailRow("Date", t.bookedAt?.take(10))
                DetailRow("Time", t.bookedAt?.let { if (it.length >= 16) it.substring(11, 16) else null })
                DetailRow("From", fromLabel(t))
                DetailRow("Sender bank", if (income) t.senderBankName else t.account)
                DetailRow("To", toLabel(t))
                DetailRow("Recipient bank", if (income) t.account else t.recipientBankName)
                DetailRow("Category", listOfNotNull(t.category, t.subcategory).joinToString(" · ").ifBlank { null })
                DetailRow("Reference", t.paymentReference)
                DetailRow("Reason", t.paymentReason)
                DetailRow("Notes", t.notes)
                DetailRow("Imported via", importedVia(t.source))

                Spacer(Modifier.height(12.dp))
                HorizontalDivider()
                Spacer(Modifier.height(8.dp))
                Text("Correct this transaction", style = MaterialTheme.typography.titleMedium)

                // Mark / undo internal transfer.
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("This is a transfer between my accounts", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    Switch(checked = t.isInternalTransfer, onCheckedChange = { vm.setInternalTransfer(t.id, it) })
                }

                // Link the other own-account (helps confirm a single-sided transfer).
                if (accounts.isNotEmpty()) {
                    LinkAccountPicker(accounts) { vm.setInternalTransfer(t.id, true, it) }
                }

                Spacer(Modifier.height(8.dp))
                TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.End)) { Text("Close") }
            }
        }
    }
}

@Composable
private fun DetailRow(label: String, value: String?) {
    if (value.isNullOrBlank()) return // omit missing fields — never show fake values
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(label, Modifier.padding(end = 8.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun LinkAccountPicker(accounts: List<AccountSummary>, onPick: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(top = 4.dp)) {
        OutlinedButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth()) {
            Text("Link the other account (mark as internal transfer)")
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            accounts.forEach { a ->
                DropdownMenuItem(text = { Text("${a.nickname} · ${a.bankName}") }, onClick = { onPick(a.id); expanded = false })
            }
        }
    }
}

private fun fromLabel(t: TransactionSummary): String? =
    if (t.direction == "INCOME") t.senderName ?: t.senderBankName else t.account
private fun toLabel(t: TransactionSummary): String? =
    if (t.direction == "INCOME") t.account else t.recipientName ?: t.merchant ?: t.recipientBankName

private fun transferRoute(t: TransactionSummary): String? {
    val from = if (t.direction == "INCOME") t.senderBankName else t.account
    val to = if (t.direction == "INCOME") t.account else t.recipientBankName
    return if (from != null && to != null) "$from → $to" else null
}

private fun prettyType(type: String?): String? = when (type) {
    null -> null
    "INTERNAL_TRANSFER" -> "Internal transfer"
    "DIRECT_DEBIT" -> "Direct debit"
    "STANDING_ORDER" -> "Standing order"
    "CASH_WITHDRAWAL" -> "Cash withdrawal"
    "BANK_FEE" -> "Bank fee"
    else -> type.lowercase().replaceFirstChar { it.uppercase() }
}

private fun importedVia(source: String?): String? = when (source) {
    "NOTIFICATION" -> "Bank notification"
    "OPEN_BANKING" -> "Open Banking"
    "STATEMENT_IMPORT", "CSV_IMPORT" -> "Statement import"
    "MANUAL" -> "Added manually"
    else -> null
}
