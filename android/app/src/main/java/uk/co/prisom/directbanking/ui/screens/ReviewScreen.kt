@file:OptIn(ExperimentalMaterial3Api::class)

package uk.co.prisom.directbanking.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import uk.co.prisom.directbanking.data.TrustedSources
import uk.co.prisom.directbanking.data.local.db.ParsedImportEntity
import uk.co.prisom.directbanking.parsing.Money
import uk.co.prisom.directbanking.ui.EmptyState
import uk.co.prisom.directbanking.ui.vm.ReviewRefData
import uk.co.prisom.directbanking.ui.vm.ReviewViewModel
import java.text.DateFormat
import java.util.Date

@Composable
fun ReviewImportsScreen(vm: ReviewViewModel) {
    val queue by vm.queue.collectAsStateWithLifecycle()
    val ref by vm.ref.collectAsStateWithLifecycle()
    if (queue.isEmpty()) {
        EmptyState("Nothing to review. Detected transactions from approved sources will appear here for you to approve before they're imported.")
    } else {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp)) {
            items(queue, key = { it.fingerprint }) { ReviewCard(it, ref, vm) }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ReviewCard(item: ParsedImportEntity, ref: ReviewRefData?, vm: ReviewViewModel) {
    // A recognised purchase whose account couldn't be resolved (round-2 §5/§12)
    // gets its own read-only card — the amount/merchant/card are already
    // correctly parsed, so this is never the "please type the amount in"
    // editable form, and never a blank/zero placeholder either.
    if (item.reviewState == "ACCOUNT_MAPPING_REQUIRED") {
        AccountMappingReviewCard(item, ref, vm)
        return
    }
    var amountText by remember(item.fingerprint) { mutableStateOf(minorToText(item.amountMinor)) }
    var isIncome by remember(item.fingerprint) { mutableStateOf(item.direction == "INCOME") }
    var merchant by remember(item.fingerprint) { mutableStateOf(item.merchant ?: "") }
    var notes by remember(item.fingerprint) { mutableStateOf("") }
    var occurredAt by remember(item.fingerprint) { mutableLongStateOf(item.occurredAtMillis) }
    var accountId by remember(item.fingerprint) { mutableStateOf<String?>(null) }
    var categoryId by remember(item.fingerprint) { mutableStateOf<String?>(null) }
    var showDate by remember { mutableStateOf(false) }

    Card(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Column(Modifier.padding(16.dp)) {
            Text(item.title, style = MaterialTheme.typography.titleMedium)
            Text(
                "${item.sourcePackage} · confidence ${(item.confidence * 100).toInt()}% · ${item.reviewState}",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(12.dp))

            OutlinedTextField(
                value = amountText, onValueChange = { amountText = it }, label = { Text("Amount (${item.currency})") },
                singleLine = true, modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            )
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = !isIncome, onClick = { isIncome = false }, label = { Text("Debit") })
                FilterChip(selected = isIncome, onClick = { isIncome = true }, label = { Text("Credit") })
            }
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(value = merchant, onValueChange = { merchant = it }, label = { Text("Merchant") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(8.dp))

            PickerField("Account (required)", accountId, ref?.accounts?.map { it.id to it.name } ?: emptyList()) { accountId = it }
            Spacer(Modifier.height(8.dp))
            PickerField("Category (optional)", categoryId, ref?.categories?.map { it.id to it.name } ?: emptyList()) { categoryId = it }
            Spacer(Modifier.height(8.dp))

            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                Text("Date: ${DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(occurredAt))}", modifier = Modifier.weight(1f))
                TextButton(onClick = { showDate = true }) { Text("Change") }
            }
            OutlinedTextField(value = notes, onValueChange = { notes = it }, label = { Text("Notes") }, modifier = Modifier.fillMaxWidth())

            Spacer(Modifier.height(12.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        vm.approve(
                            fingerprint = item.fingerprint,
                            accountId = accountId!!,
                            categoryId = categoryId,
                            amountMinor = Money.toMinor(amountText),
                            direction = if (isIncome) "INCOME" else "EXPENSE",
                            merchant = merchant.ifBlank { null },
                            occurredAtMillis = occurredAt,
                            notes = notes.ifBlank { null },
                        )
                    },
                    enabled = accountId != null && (Money.toMinor(amountText) ?: 0) > 0,
                ) { Text("Approve") }
                OutlinedButton(onClick = { vm.reject(item.fingerprint) }) { Text("Reject") }
                OutlinedButton(onClick = { vm.ignoreSource(item.sourcePackage) }) { Text("Ignore source") }
            }
        }
    }

    if (showDate) {
        val dateState = rememberDatePickerState(initialSelectedDateMillis = occurredAt)
        DatePickerDialog(
            onDismissRequest = { showDate = false },
            confirmButton = { TextButton(onClick = { dateState.selectedDateMillis?.let { occurredAt = it }; showDate = false }) { Text("OK") } },
            dismissButton = { TextButton(onClick = { showDate = false }) { Text("Cancel") } },
        ) { DatePicker(state = dateState) }
    }
}

/**
 * A recognised card purchase whose account couldn't be resolved (round-2 §5/
 * §12) — read-only, correctly-parsed details (never £0.00), with an explicit
 * account picker rather than the generic "type the amount in" review form.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AccountMappingReviewCard(item: ParsedImportEntity, ref: ReviewRefData?, vm: ReviewViewModel) {
    var accountId by remember(item.fingerprint) { mutableStateOf<String?>(null) }
    val sourceLabel = TrustedSources.displayName(item.sourcePackage) ?: item.sourcePackage

    Card(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Column(Modifier.padding(16.dp)) {
            Text(sourceLabel, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(item.merchant ?: item.title, style = MaterialTheme.typography.titleMedium)
            Text(Money.format(item.amountMinor, item.currency), style = MaterialTheme.typography.titleLarge)
            item.accountHint?.let { Text("Card ••••$it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }

            Spacer(Modifier.height(12.dp))
            Text("Reason", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("Select which account this card belongs to", style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(8.dp))

            PickerField("Account", accountId, ref?.accounts?.map { it.id to it.name } ?: emptyList()) { accountId = it }

            Spacer(Modifier.height(12.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        accountId?.let { id ->
                            vm.approve(
                                fingerprint = item.fingerprint,
                                accountId = id,
                                categoryId = null,
                                amountMinor = item.amountMinor,
                                direction = item.direction,
                                merchant = item.merchant,
                                occurredAtMillis = item.occurredAtMillis,
                                notes = null,
                            )
                        }
                    },
                    enabled = accountId != null,
                ) { Text("Link account") }
                OutlinedButton(onClick = { /* leave queued exactly as-is — no action needed to "keep for review" */ }) { Text("Keep for review") }
            }
        }
    }
}

@Composable
private fun PickerField(label: String, selectedId: String?, options: List<Pair<String, String>>, onSelect: (String?) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val selectedLabel = options.firstOrNull { it.first == selectedId }?.second ?: ""
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = selectedLabel, onValueChange = {}, readOnly = true, label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.menuAnchor().fillMaxWidth(),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEach { (id, name) ->
                DropdownMenuItem(text = { Text(name) }, onClick = { onSelect(id); expanded = false })
            }
        }
    }
}

private fun minorToText(minor: Long): String = "%.2f".format(minor / 100.0)
