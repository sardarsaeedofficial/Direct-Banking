package uk.co.prisom.directbanking.ui.screens

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.KeyboardOptions
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import uk.co.prisom.directbanking.ui.EmptyState
import uk.co.prisom.directbanking.ui.LoadingBox
import uk.co.prisom.directbanking.ui.MessageBox
import uk.co.prisom.directbanking.ui.vm.Async
import uk.co.prisom.directbanking.ui.vm.BudgetsViewModel

@Composable
fun BudgetsScreen(vm: BudgetsViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    val showCreate by vm.showCreate.collectAsStateWithLifecycle()

    Scaffold(
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { vm.openCreate() },
                icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                text = { Text("New budget") },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            when (val s = state) {
                is Async.Loading -> LoadingBox()
                is Async.Failure -> MessageBox(s.message)
                is Async.Success -> {
                    if (s.data.isEmpty()) EmptyState("No budgets yet. Tap “New budget” to set a monthly limit.")
                    LazyColumn(Modifier.fillMaxWidth()) {
                        items(s.data) { b ->
                            Card(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)) {
                                Row(Modifier.fillMaxWidth().padding(14.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                                    Column(Modifier.weight(1f)) { BudgetRow(b) }
                                    IconButton(onClick = { vm.delete(b.budgetId) }) {
                                        Icon(Icons.Filled.Delete, contentDescription = "Delete budget")
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (showCreate) CreateBudgetDialog(vm)
}

@Composable
private fun CreateBudgetDialog(vm: BudgetsViewModel) {
    val categories by vm.categories.collectAsStateWithLifecycle()
    var name by remember { mutableStateOf("") }
    var limitText by remember { mutableStateOf("") }
    var categoryId by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = { vm.dismissCreate() },
        title = { Text("New budget") },
        text = {
            Column {
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(
                    value = limitText,
                    onValueChange = { limitText = it.filter { c -> c.isDigit() || c == '.' } },
                    label = { Text("Monthly limit (£)") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                )
                Text("Category", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 12.dp))
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    FilterChip(selected = categoryId == null, onClick = { categoryId = null }, label = { Text("Overall") })
                    categories.forEach { c ->
                        FilterChip(selected = categoryId == c.id, onClick = { categoryId = c.id }, label = { Text(c.name) })
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = name.isNotBlank() && (limitText.toDoubleOrNull() ?: 0.0) > 0,
                onClick = {
                    val minor = ((limitText.toDoubleOrNull() ?: 0.0) * 100).toLong()
                    vm.create(name.trim(), categoryId, minor)
                },
            ) { Text("Create") }
        },
        dismissButton = { TextButton(onClick = { vm.dismissCreate() }) { Text("Cancel") } },
    )
}
