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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import uk.co.prisom.directbanking.data.remote.dto.CurrencySummaryDto
import uk.co.prisom.directbanking.data.remote.dto.InsightsOverviewDto
import uk.co.prisom.directbanking.data.remote.dto.UpcomingPaymentP4Dto
import uk.co.prisom.directbanking.domain.AccountSummary
import uk.co.prisom.directbanking.domain.BankSyncStatus
import uk.co.prisom.directbanking.domain.TransactionSummary
import uk.co.prisom.directbanking.ui.EmptyState
import uk.co.prisom.directbanking.ui.LoadingBox
import uk.co.prisom.directbanking.ui.money
import uk.co.prisom.directbanking.ui.vm.Async
import uk.co.prisom.directbanking.ui.vm.HomeExtras
import uk.co.prisom.directbanking.ui.vm.HomeViewModel
import uk.co.prisom.directbanking.ui.vm.SyncViewModel
import java.text.DateFormat
import java.util.Date

private fun sourceLabel(source: String): String = when (source.uppercase()) {
    "DIRECT_DEBIT" -> "Direct Debit"
    "SUBSCRIPTION" -> "Subscription"
    "STANDING_ORDER" -> "Standing order"
    "RECURRING_CARD", "RECURRING", "RECURRING_TRANSFER" -> "Recurring payment"
    "SALARY", "INCOME" -> "Expected income"
    else -> source.replace('_', ' ').lowercase().replaceFirstChar { it.uppercase() }
}

/**
 * Redesigned Home (Phase 4). Sections, in order: title · Total balance/Net worth ·
 * This month · Safe to spend · Upcoming payments · Budget progress · Recent activity
 * · Connected bank status. Renders from the Room-cached insights overview so it stays
 * populated offline (with a staleness note); Phase 1–3 entry points are preserved.
 */
@Composable
fun HomeScreen(
    home: HomeViewModel,
    sync: SyncViewModel,
    onCashFlow: () -> Unit = {},
    onPayments: () -> Unit = {},
    onBudgets: () -> Unit = {},
    onActivity: () -> Unit = {},
    onAccounts: () -> Unit = {},
    onDirectDebits: () -> Unit = {},
    onSyncStatus: () -> Unit = {},
    onNotifications: () -> Unit = {},
) {
    val state by home.overview.collectAsStateWithLifecycle()
    val extras by home.extras.collectAsStateWithLifecycle()
    val lastSync by sync.lastSyncAtMillis.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Text("Direct Banking", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        extras.displayName?.let {
            Text("Hello, $it", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.height(12.dp))

        when (val s = state) {
            is Async.Loading -> LoadingBox()
            is Async.Failure -> {
                // No cached data available AND the network failed — offer a retry, never a blank screen.
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp)) {
                        Text("Couldn't load your overview", fontWeight = FontWeight.SemiBold)
                        Text("Check your connection and try again.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.height(8.dp))
                        OutlinedButton(onClick = { home.refresh() }) { Text("Retry") }
                    }
                }
            }
            is Async.Success -> {
                val overview = s.data.data
                if (s.data.isStale) {
                    Text(
                        "Showing saved data — couldn't reach the server",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(bottom = 8.dp),
                    )
                }
                BalanceSection(overview, extras.accounts)
                Spacer(Modifier.height(12.dp))
                ThisMonthSection(overview)
                Spacer(Modifier.height(12.dp))
                SafeToSpendSection(overview, onCashFlow)
                Spacer(Modifier.height(12.dp))
                UpcomingSection(overview, onPayments)
                Spacer(Modifier.height(12.dp))
                BudgetsSection(overview, onBudgets)
                Spacer(Modifier.height(12.dp))
                RecentActivitySection(extras.recent, onActivity)
                Spacer(Modifier.height(12.dp))
                BankStatusSection(extras.bankSync, lastSync)
                Spacer(Modifier.height(16.dp))
                MoreSection(onAccounts, onDirectDebits, onSyncStatus, onNotifications, home::refresh)
            }
        }
    }
}

@Composable
private fun SectionHeader(title: String, actionLabel: String? = null, onAction: (() -> Unit)? = null) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        if (actionLabel != null && onAction != null) TextButton(onClick = onAction) { Text(actionLabel) }
    }
}

@Composable
private fun Tile(label: String, value: String, modifier: Modifier = Modifier) {
    Card(modifier) {
        Column(Modifier.padding(14.dp)) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(4.dp))
            Text(value, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun BalanceSection(o: InsightsOverviewDto, accounts: List<AccountSummary>) {
    val nw = o.netWorth.currencies
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            if (nw.isNotEmpty()) {
                Text("Net worth", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                // One row per currency — currencies are never silently combined.
                nw.forEach { c ->
                    Spacer(Modifier.height(4.dp))
                    Text(money(c.netWorthMinor, c.currency), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Text(
                        "Assets ${money(c.assetsMinor, c.currency)} · Liabilities ${money(c.liabilitiesMinor, c.currency)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                // Fallback: per-currency account totals (labelled, no invented FX).
                Text("Total balance", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                val byCurrency = accounts.groupBy { it.currency }.mapValues { (_, list) -> list.sumOf { it.balanceMinor } }
                if (byCurrency.isEmpty()) {
                    Spacer(Modifier.height(4.dp))
                    Text("No accounts yet", style = MaterialTheme.typography.bodyMedium)
                } else {
                    byCurrency.forEach { (cur, total) ->
                        Spacer(Modifier.height(4.dp))
                        Text(money(total, cur), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}

@Composable
private fun ThisMonthSection(o: InsightsOverviewDto) {
    SectionHeader("This month")
    Spacer(Modifier.height(6.dp))
    val primary: CurrencySummaryDto = o.summary.currencies.firstOrNull { it.currency == o.summary.primaryCurrency }
        ?: o.summary.currencies.firstOrNull() ?: CurrencySummaryDto()
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Tile("Income", money(primary.incomeMinor, primary.currency), Modifier.weight(1f))
        Tile("Spending", money(primary.spendingMinor, primary.currency), Modifier.weight(1f))
        Tile("Net", money(primary.netMinor, primary.currency), Modifier.weight(1f))
    }
    // Additional currencies get their own net line — never merged into the primary.
    o.summary.currencies.filter { it.currency != primary.currency }.forEach {
        Text("Net (${it.currency}): ${money(it.netMinor, it.currency)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun SafeToSpendSection(o: InsightsOverviewDto, onCashFlow: () -> Unit) {
    val s = o.safeToSpend
    Card(Modifier.fillMaxWidth().clickable { onCashFlow() }) {
        Column(Modifier.padding(16.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Safe to spend", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Text(s.label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.height(4.dp))
            Text(money(s.safeToSpendMinor, s.currency), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text(
                "After ${money(s.upcomingCommittedMinor, s.currency)} upcoming" + if (s.minReserveMinor > 0) " · ${money(s.minReserveMinor, s.currency)} reserve" else "",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            TextButton(onClick = onCashFlow) { Text("Cash flow details") }
        }
    }
}

@Composable
private fun UpcomingSection(o: InsightsOverviewDto, onPayments: () -> Unit) {
    SectionHeader("Upcoming payments", "See all", onPayments)
    Spacer(Modifier.height(6.dp))
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
            if (o.upcoming.isEmpty()) {
                EmptyState("Nothing due soon")
            } else {
                val primaryCur = o.safeToSpend.currency
                o.upcoming.sortedBy { it.dueIso }.take(4).forEach { UpcomingRow(it) }
                val total = o.upcoming.filter { it.currency == primaryCur }.sumOf { it.amountMinor }
                Row(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
                    Text("Expected total", Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(money(total, primaryCur), fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

@Composable
private fun UpcomingRow(p: UpcomingPaymentP4Dto) {
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(p.name, style = MaterialTheme.typography.bodyLarge)
            Text(
                listOfNotNull(sourceLabel(p.source), p.dueIso.take(10).ifBlank { null }, p.label.ifBlank { null }).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(money(p.amountMinor, p.currency), fontWeight = FontWeight.SemiBold)
    }
    HorizontalDivider()
}

@Composable
private fun BudgetsSection(o: InsightsOverviewDto, onBudgets: () -> Unit) {
    SectionHeader("Budget progress", "Manage", onBudgets)
    Spacer(Modifier.height(6.dp))
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            if (o.budgets.isEmpty()) {
                EmptyState("No budgets yet")
            } else {
                // Highest-utilisation budgets first (most likely to need attention).
                o.budgets.sortedByDescending { it.pctBps }.take(3).forEach { BudgetRow(it) }
            }
        }
    }
}

@Composable
private fun RecentActivitySection(recent: List<TransactionSummary>, onActivity: () -> Unit) {
    SectionHeader("Recent activity", "See all", onActivity)
    Spacer(Modifier.height(6.dp))
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
            if (recent.isEmpty()) {
                EmptyState("No transactions yet")
            } else {
                recent.forEach { t ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(t.merchant ?: t.description, style = MaterialTheme.typography.bodyLarge, maxLines = 1)
                            Text(
                                listOfNotNull(t.category, t.bookedAt?.take(10)).joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        val sign = if (t.direction == "INCOME") "+" else "-"
                        Text(sign + money(t.amountMinor, t.currency), fontWeight = FontWeight.SemiBold)
                    }
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
private fun BankStatusSection(bs: BankSyncStatus, lastSyncMillis: Long) {
    SectionHeader("Connected banks")
    Spacer(Modifier.height(6.dp))
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text(
                "Notifications synced: " + if (lastSyncMillis > 0) DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(lastSyncMillis)) else "never",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            val text = when {
                bs.connectionCount == 0 -> "No banks connected"
                bs.needsAttention > 0 -> "${bs.needsAttention} bank${if (bs.needsAttention > 1) "s" else ""} need attention"
                bs.lastBankSyncAt != null -> "Banks synced ${bs.lastBankSyncAt.take(10)}"
                else -> "Banks connected: ${bs.connectionCount}"
            }
            Text(
                text,
                style = MaterialTheme.typography.bodyMedium,
                color = if (bs.needsAttention > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

@Composable
private fun MoreSection(
    onAccounts: () -> Unit,
    onDirectDebits: () -> Unit,
    onSyncStatus: () -> Unit,
    onNotifications: () -> Unit,
    onRefresh: () -> Unit,
) {
    SectionHeader("More")
    Spacer(Modifier.height(8.dp))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = onAccounts, modifier = Modifier.weight(1f)) { Text("Accounts") }
        OutlinedButton(onClick = onDirectDebits, modifier = Modifier.weight(1f)) { Text("Direct debits") }
    }
    Spacer(Modifier.height(8.dp))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = onSyncStatus, modifier = Modifier.weight(1f)) { Text("Sync status") }
        OutlinedButton(onClick = onNotifications, modifier = Modifier.weight(1f)) { Text("Notifications") }
    }
    Spacer(Modifier.height(8.dp))
    OutlinedButton(onClick = onRefresh) { Text("Refresh") }
}
