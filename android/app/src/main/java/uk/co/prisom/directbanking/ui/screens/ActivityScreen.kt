package uk.co.prisom.directbanking.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.clickable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import uk.co.prisom.directbanking.domain.AccountSummary
import uk.co.prisom.directbanking.domain.TransactionSummary
import uk.co.prisom.directbanking.ui.EmptyState
import uk.co.prisom.directbanking.ui.LifecycleBadge
import uk.co.prisom.directbanking.ui.LifecycleIconKind
import uk.co.prisom.directbanking.ui.LifecycleTone
import uk.co.prisom.directbanking.ui.LoadingBox
import uk.co.prisom.directbanking.ui.MessageBox
import uk.co.prisom.directbanking.ui.amountPrefix
import uk.co.prisom.directbanking.ui.evidenceSummary
import uk.co.prisom.directbanking.ui.expectedDateLabel
import uk.co.prisom.directbanking.ui.lifecycleBadge
import uk.co.prisom.directbanking.ui.lifecycleLabel
import uk.co.prisom.directbanking.ui.lifecycleMessage
import uk.co.prisom.directbanking.ui.money
import uk.co.prisom.directbanking.ui.paymentRailLabel
import uk.co.prisom.directbanking.ui.theme.DirectBankingColors
import uk.co.prisom.directbanking.ui.vm.ActivityFilter
import uk.co.prisom.directbanking.ui.vm.ActivityLifecycleFilter
import uk.co.prisom.directbanking.ui.vm.Async
import uk.co.prisom.directbanking.ui.vm.TransactionsViewModel

@Composable
fun TransactionsScreen(vm: TransactionsViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    val filter by vm.filter.collectAsStateWithLifecycle()
    val lifecycleFilter by vm.lifecycleFilter.collectAsStateWithLifecycle()
    val query by vm.query.collectAsStateWithLifecycle()
    val accounts by vm.accounts.collectAsStateWithLifecycle()
    val selected by vm.selected.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize()) {
        // Compact lifecycle selector (round-2 §3) — a separate row from the
        // existing type filters below, so Income/Spending/etc. keep working
        // unchanged and this one purely narrows by lifecycle server-side.
        LazyRow(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(ActivityLifecycleFilter.entries.toList(), key = { it.name }) { f ->
                FilterChip(selected = lifecycleFilter == f, onClick = { vm.setLifecycleFilter(f) }, label = { Text(f.label) })
            }
        }
        LazyRow(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
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
                    items(s.data, key = { "${it.kind}:${it.id}" }) { ActivityRow(it) { vm.open(it) } }
                }
            }
        }
    }

    selected?.let { txn ->
        TransactionDetailDialog(txn, accounts, onDismiss = vm::close, vm = vm)
    }
}

private fun LifecycleIconKind.toImageVector(): ImageVector = when (this) {
    LifecycleIconKind.INFO -> Icons.Filled.Info
    LifecycleIconKind.WARNING -> Icons.Filled.Warning
    LifecycleIconKind.REFRESH -> Icons.Filled.Refresh
}

@Composable
private fun toneColor(tone: LifecycleTone) = when (tone) {
    LifecycleTone.NEGATIVE -> MaterialTheme.colorScheme.error
    LifecycleTone.POSITIVE -> DirectBankingColors.income
    LifecycleTone.NEUTRAL -> MaterialTheme.colorScheme.onSurfaceVariant
}

/** Amount colour — never the completed red/green treatment for a lifecycle
 *  that hasn't actually moved money yet (round-2 §1 safety requirement). */
@Composable
private fun amountColor(t: TransactionSummary, badge: LifecycleBadge?): Color = when {
    badge != null && badge.tone != LifecycleTone.POSITIVE -> MaterialTheme.colorScheme.onSurfaceVariant
    t.isInternalTransfer -> MaterialTheme.colorScheme.onSurfaceVariant
    t.direction == "INCOME" -> DirectBankingColors.income
    else -> DirectBankingColors.expense
}

@Composable
private fun ActivityRow(t: TransactionSummary, onClick: () -> Unit) {
    val badge = lifecycleBadge(t)
    Column(Modifier.clickable(onClick = onClick)) {
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(t.description, style = MaterialTheme.typography.titleMedium)
                if (badge != null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(badge.icon.toImageVector(), contentDescription = null, modifier = Modifier.size(14.dp), tint = toneColor(badge.tone))
                        Spacer(Modifier.width(4.dp))
                        Text(badge.statusText, style = MaterialTheme.typography.bodySmall, color = toneColor(badge.tone), fontWeight = FontWeight.Medium)
                    }
                    badge.subText?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                } else {
                    Text(
                        listOfNotNull(subtitleType(t), t.category, t.account, t.bookedAt?.take(10)).joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (t.isInternalTransfer) {
                Text(money(t.amountMinor, t.currency), fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                Text(
                    amountPrefix(t, badge) + money(t.amountMinor, t.currency),
                    color = amountColor(t, badge),
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
    t.isCreditCardRepayment -> "Credit-card repayment"
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
    val badge = lifecycleBadge(t)
    Dialog(onDismissRequest = onDismiss) {
        Card {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp)) {
                Text(t.description, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(4.dp))
                Text(
                    amountPrefix(t, badge) + money(t.amountMinor, t.currency),
                    style = MaterialTheme.typography.headlineSmall,
                    color = when {
                        t.isInternalTransfer -> MaterialTheme.colorScheme.onSurface
                        else -> amountColor(t, badge)
                    },
                )

                lifecycleMessage(t)?.let {
                    Spacer(Modifier.height(8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        badge?.let { b -> Icon(b.icon.toImageVector(), contentDescription = null, modifier = Modifier.size(16.dp), tint = toneColor(b.tone)) }
                        Spacer(Modifier.width(6.dp))
                        Text(it, style = MaterialTheme.typography.bodyMedium, color = badge?.let { b -> toneColor(b.tone) } ?: MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }

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
                // Required fields (round-2 §2): Type, Lifecycle, Amount (above),
                // Account, Expected vs actual, Occurred date, Expected date where
                // present, Merchant/payee, Payment rail, Category, Source/evidence.
                DetailRow("Type", if (t.isCreditCardRepayment) "Credit-card repayment" else prettyType(t.transactionType) ?: t.direction)
                DetailRow("Lifecycle", lifecycleLabel(t.lifecycle))
                DetailRow("Account", t.account)
                DetailRow("Occurred", t.bookedAt?.take(10))
                DetailRow("Expected", t.expectedAt?.take(10)?.let { expectedDateLabel(t.expectedAt) })
                if (t.lifecycle == "COMPLETED" && t.expectedAt != null) {
                    DetailRow("Actual", t.bookedAt?.take(10))
                }
                DetailRow("Merchant/payee", t.merchant ?: fromLabel(t) ?: toLabel(t))
                DetailRow("Payment rail", paymentRailLabel(t.paymentRail))
                DetailRow("From", fromLabel(t))
                DetailRow("Sender bank", if (t.direction == "INCOME") t.senderBankName else t.account)
                DetailRow("To", toLabel(t))
                DetailRow("Recipient bank", if (t.direction == "INCOME") t.account else t.recipientBankName)
                DetailRow("Category", listOfNotNull(t.category, t.subcategory).joinToString(" · ").ifBlank { null })
                DetailRow("Reference", t.paymentReference)
                DetailRow("Reason", t.paymentReason)
                DetailRow("Notes", t.notes)
                DetailRow("Source", if (t.isFinancialEvent) "Bank notification (not yet posted)" else importedVia(t.source))
                DetailRow("Evidence", t.reasonCode?.let { evidenceSummary(it) })

                if (!t.isFinancialEvent) {
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
                } else {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "This is a forecast from a bank notification, not yet a posted transaction — nothing to correct here.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
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
    "CREDIT_CARD_REPAYMENT" -> "Credit-card repayment"
    else -> type.lowercase().replaceFirstChar { it.uppercase() }
}

private fun importedVia(source: String?): String? = when (source) {
    "NOTIFICATION" -> "Bank notification"
    "OPEN_BANKING" -> "Open Banking"
    "STATEMENT_IMPORT", "CSV_IMPORT" -> "Statement import"
    "MANUAL" -> "Added manually"
    else -> null
}
