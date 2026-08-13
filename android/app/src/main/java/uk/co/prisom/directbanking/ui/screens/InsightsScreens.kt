package uk.co.prisom.directbanking.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import uk.co.prisom.directbanking.data.remote.dto.BudgetProgressDto
import uk.co.prisom.directbanking.data.remote.dto.CurrencySummaryDto
import uk.co.prisom.directbanking.data.remote.dto.InsightsOverviewDto
import uk.co.prisom.directbanking.ui.EmptyState
import uk.co.prisom.directbanking.ui.LoadingBox
import uk.co.prisom.directbanking.ui.MessageBox
import uk.co.prisom.directbanking.ui.money
import uk.co.prisom.directbanking.ui.vm.Async
import uk.co.prisom.directbanking.ui.vm.InsightsTab
import uk.co.prisom.directbanking.ui.vm.InsightsViewModel

private fun bps(v: Int): String = "${"%.1f".format(v / 100.0)}%"
private fun parseColour(hex: String?): Color = runCatching { Color(android.graphics.Color.parseColor(hex ?: "#64748b")) }.getOrDefault(Color(0xFF64748B))

@Composable
fun InsightsScreen(vm: InsightsViewModel) {
    val tab by vm.tab.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxWidth()) {
        ScrollableTabRow(selectedTabIndex = tab.ordinal, edgePadding = 8.dp) {
            InsightsTab.entries.forEach { t ->
                Tab(selected = t == tab, onClick = { vm.setTab(t) }, text = { Text(t.label) })
            }
        }
        when (tab) {
            InsightsTab.OVERVIEW -> OverviewTab(vm)
            InsightsTab.CATEGORIES -> CategoriesTab(vm)
            InsightsTab.MERCHANTS -> MerchantsTab(vm)
            InsightsTab.CASH_FLOW -> CashFlowTab(vm)
            InsightsTab.NET_WORTH -> NetWorthTab(vm)
        }
    }
}

@Composable
private fun SectionCard(title: String, content: @Composable () -> Unit) {
    Card(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)) {
        Column(Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            content()
        }
    }
}

@Composable
private fun KeyValueRow(label: String, value: String, emphasise: Boolean = false) {
    Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, fontWeight = if (emphasise) FontWeight.Bold else FontWeight.Medium)
    }
}

@Composable
private fun OverviewTab(vm: InsightsViewModel) {
    val state by vm.overview.collectAsStateWithLifecycle()
    when (val s = state) {
        is Async.Loading -> LoadingBox()
        is Async.Failure -> MessageBox(s.message)
        is Async.Success -> {
            val overview = s.data.data
            LazyColumn(Modifier.fillMaxWidth()) {
                if (s.data.isStale) item {
                    Text(
                        "Showing saved data — couldn't reach the server",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }
                item { ThisMonthCard(overview) }
                item { SafeToSpendCard(overview) }
                item { NetWorthSummaryCard(overview) }
                item { BudgetsCard(overview.budgets) }
                item { UpcomingCard(overview) }
            }
        }
    }
}

@Composable
private fun ThisMonthCard(o: InsightsOverviewDto) {
    val primary: CurrencySummaryDto = o.summary.currencies.firstOrNull { it.currency == o.summary.primaryCurrency }
        ?: o.summary.currencies.firstOrNull() ?: CurrencySummaryDto()
    SectionCard("This month") {
        KeyValueRow("Income", money(primary.incomeMinor, primary.currency))
        KeyValueRow("Spending", money(primary.spendingMinor, primary.currency))
        KeyValueRow("Net", money(primary.netMinor, primary.currency), emphasise = true)
        primary.savingsRateBps?.let { KeyValueRow("Savings rate", bps(it)) }
        // Any additional currencies are shown separately — never combined.
        o.summary.currencies.filter { it.currency != primary.currency }.forEach {
            KeyValueRow("Net (${it.currency})", money(it.netMinor, it.currency))
        }
    }
}

@Composable
private fun SafeToSpendCard(o: InsightsOverviewDto) {
    val s = o.safeToSpend
    SectionCard("Safe to spend (${s.label})") {
        KeyValueRow("Available", money(s.availableMinor, s.currency))
        KeyValueRow("Upcoming committed", money(s.upcomingCommittedMinor, s.currency))
        if (s.minReserveMinor > 0) KeyValueRow("Reserve", money(s.minReserveMinor, s.currency))
        KeyValueRow("Safe to spend", money(s.safeToSpendMinor, s.currency), emphasise = true)
    }
}

@Composable
private fun NetWorthSummaryCard(o: InsightsOverviewDto) {
    val c = o.netWorth.currencies.firstOrNull() ?: return
    SectionCard("Net worth") {
        KeyValueRow("Assets", money(c.assetsMinor, c.currency))
        KeyValueRow("Liabilities", money(c.liabilitiesMinor, c.currency))
        KeyValueRow("Net worth", money(c.netWorthMinor, c.currency), emphasise = true)
    }
}

@Composable
private fun BudgetsCard(budgets: List<BudgetProgressDto>) {
    SectionCard("Budgets") {
        if (budgets.isEmpty()) EmptyState("No budgets yet")
        budgets.forEach { BudgetRow(it) }
    }
}

@Composable
fun BudgetRow(b: BudgetProgressDto) {
    val fraction = (b.pctBps / 10000f).coerceIn(0f, 1f)
    val colour = when (b.status) {
        "OVER_BUDGET" -> MaterialTheme.colorScheme.error
        "APPROACHING_LIMIT" -> Color(0xFFF59E0B)
        else -> MaterialTheme.colorScheme.primary
    }
    Column(Modifier.fillMaxWidth().padding(top = 10.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(b.name, fontWeight = FontWeight.Medium)
            Text("${money(b.spentMinor, b.currency)} / ${money(b.limitMinor, b.currency)}", style = MaterialTheme.typography.bodySmall)
        }
        LinearProgressIndicator(progress = { fraction }, color = colour, modifier = Modifier.fillMaxWidth().padding(top = 4.dp))
        Text(
            if (b.remainingMinor >= 0) "${money(b.remainingMinor, b.currency)} left" else "${money(-b.remainingMinor, b.currency)} over",
            style = MaterialTheme.typography.bodySmall,
            color = if (b.remainingMinor < 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun UpcomingCard(o: InsightsOverviewDto) {
    SectionCard("Upcoming payments") {
        if (o.upcoming.isEmpty()) EmptyState("Nothing due soon")
        o.upcoming.take(8).forEach {
            KeyValueRow("${it.name} · ${it.label}", money(it.amountMinor, it.currency))
        }
    }
}

@Composable
private fun CategoriesTab(vm: InsightsViewModel) {
    val state by vm.categories.collectAsStateWithLifecycle()
    val period by vm.categoryPeriod.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("week", "month", "year").forEach { p ->
                FilterChip(selected = p == period, onClick = { vm.setCategoryPeriod(p) }, label = { Text(p.replaceFirstChar { it.uppercase() }) })
            }
        }
        when (val s = state) {
            is Async.Loading -> LoadingBox()
            is Async.Failure -> MessageBox(s.message)
            is Async.Success -> {
                if (s.data.categories.isEmpty()) EmptyState("No spending in this period")
                LazyColumn(Modifier.fillMaxWidth()) {
                    items(s.data.categories) { c ->
                        Card(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
                            Column(Modifier.padding(14.dp)) {
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                    Text(c.name, fontWeight = FontWeight.Medium)
                                    Text(money(c.spentMinor, s.data.currency), fontWeight = FontWeight.SemiBold)
                                }
                                LinearProgressIndicator(
                                    progress = { (c.pctBps / 10000f).coerceIn(0f, 1f) },
                                    color = parseColour(c.colour),
                                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                                )
                                Text("${bps(c.pctBps)} · ${c.txnCount} transactions", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MerchantsTab(vm: InsightsViewModel) {
    val state by vm.merchants.collectAsStateWithLifecycle()
    when (val s = state) {
        is Async.Loading -> LoadingBox()
        is Async.Failure -> MessageBox(s.message)
        is Async.Success -> {
            if (s.data.merchants.isEmpty()) EmptyState("No merchant spending yet")
            LazyColumn(Modifier.fillMaxWidth()) {
                items(s.data.merchants) { m ->
                    Card(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
                        Row(Modifier.fillMaxWidth().padding(14.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                            Column {
                                Text(m.displayName, fontWeight = FontWeight.Medium)
                                Text("${m.txnCount} transactions", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Text(money(m.spentMinor, s.data.currency), fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CashFlowTab(vm: InsightsViewModel) {
    val state by vm.cashFlow.collectAsStateWithLifecycle()
    when (val s = state) {
        is Async.Loading -> LoadingBox()
        is Async.Failure -> MessageBox(s.message)
        is Async.Success -> {
            val f = s.data
            LazyColumn(Modifier.fillMaxWidth()) {
                item {
                    SectionCard("Forecast (${f.label})") {
                        KeyValueRow("Current balance", money(f.currentBalanceMinor, f.currency))
                        KeyValueRow("Next 7 days (projected)", money(f.next7.projectedBalanceMinor, f.currency))
                        KeyValueRow("Next 30 days (projected)", money(f.next30.projectedBalanceMinor, f.currency))
                        KeyValueRow("End of month (projected)", money(f.endOfMonth.projectedBalanceMinor, f.currency), emphasise = true)
                    }
                }
                item {
                    SectionCard("Expected outgoings") {
                        if (f.upcoming.isEmpty()) EmptyState("Nothing expected")
                        f.upcoming.forEach { KeyValueRow("${it.name} · ${it.label}", money(it.amountMinor, it.currency)) }
                    }
                }
            }
        }
    }
}

@Composable
private fun NetWorthTab(vm: InsightsViewModel) {
    val state by vm.netWorth.collectAsStateWithLifecycle()
    when (val s = state) {
        is Async.Loading -> LoadingBox()
        is Async.Failure -> MessageBox(s.message)
        is Async.Success -> {
            if (s.data.currencies.isEmpty()) EmptyState("No accounts yet")
            LazyColumn(Modifier.fillMaxWidth()) {
                items(s.data.currencies) { c ->
                    SectionCard("Net worth (${c.currency})") {
                        KeyValueRow("Assets", money(c.assetsMinor, c.currency))
                        KeyValueRow("Liabilities", money(c.liabilitiesMinor, c.currency))
                        KeyValueRow("Net worth", money(c.netWorthMinor, c.currency), emphasise = true)
                        c.accounts.forEach {
                            KeyValueRow("${it.name} (${it.classification.lowercase()})", money(it.balanceMinor, c.currency))
                        }
                    }
                }
            }
        }
    }
}
