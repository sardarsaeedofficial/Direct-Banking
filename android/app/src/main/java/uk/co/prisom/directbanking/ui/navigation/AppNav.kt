package uk.co.prisom.directbanking.ui.navigation

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Payments
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import uk.co.prisom.directbanking.debug.DebugHooks
import uk.co.prisom.directbanking.debug.addDebugDestinations
import uk.co.prisom.directbanking.ui.LocalContainer
import uk.co.prisom.directbanking.ui.containerViewModel
import uk.co.prisom.directbanking.ui.screens.AccountsScreen
import uk.co.prisom.directbanking.ui.screens.ApprovedSourcesScreen
import uk.co.prisom.directbanking.ui.screens.BankConnectionDetailScreen
import uk.co.prisom.directbanking.ui.screens.BankConnectionsScreen
import uk.co.prisom.directbanking.ui.screens.CreateAccountScreen
import uk.co.prisom.directbanking.ui.screens.HomeScreen
import uk.co.prisom.directbanking.ui.screens.DiagnosticsScreen
import uk.co.prisom.directbanking.ui.screens.DirectDebitsScreen
import uk.co.prisom.directbanking.ui.screens.DirectDebitDetailScreen
import uk.co.prisom.directbanking.ui.screens.DisclosureScreen
import uk.co.prisom.directbanking.ui.screens.InsightsScreen
import uk.co.prisom.directbanking.ui.screens.BudgetsScreen
import uk.co.prisom.directbanking.ui.screens.PaymentsScreen
import uk.co.prisom.directbanking.ui.screens.StatementImportScreen
import uk.co.prisom.directbanking.ui.screens.ReviewCentreScreen
import uk.co.prisom.directbanking.ui.screens.NotificationAccessScreen
import uk.co.prisom.directbanking.ui.screens.NotificationsScreen
import uk.co.prisom.directbanking.ui.screens.ReviewImportsScreen
import uk.co.prisom.directbanking.ui.screens.SettingsScreen
import uk.co.prisom.directbanking.ui.screens.SignInScreen
import uk.co.prisom.directbanking.ui.screens.SplashScreen
import uk.co.prisom.directbanking.ui.screens.SyncStatusScreen
import uk.co.prisom.directbanking.ui.screens.TransactionsScreen
import uk.co.prisom.directbanking.ui.session.SessionState
import uk.co.prisom.directbanking.ui.session.SessionViewModel
import uk.co.prisom.directbanking.ui.vm.BankConnectionDetailViewModel
import uk.co.prisom.directbanking.ui.vm.BankConnectionsViewModel
import uk.co.prisom.directbanking.ui.vm.DiagnosticsViewModel
import uk.co.prisom.directbanking.ui.vm.DirectDebitDetailViewModel
import uk.co.prisom.directbanking.ui.vm.DirectDebitsViewModel
import uk.co.prisom.directbanking.ui.vm.HomeViewModel
import uk.co.prisom.directbanking.ui.vm.InsightsViewModel
import uk.co.prisom.directbanking.ui.vm.BudgetsViewModel
import uk.co.prisom.directbanking.ui.vm.PaymentsViewModel
import uk.co.prisom.directbanking.ui.vm.StatementImportViewModel
import uk.co.prisom.directbanking.ui.vm.ReviewCentreViewModel
import uk.co.prisom.directbanking.ui.vm.OverviewViewModel
import uk.co.prisom.directbanking.ui.vm.ReviewViewModel
import uk.co.prisom.directbanking.ui.vm.SettingsViewModel
import uk.co.prisom.directbanking.ui.vm.SourcesViewModel
import uk.co.prisom.directbanking.ui.vm.SyncViewModel
import uk.co.prisom.directbanking.ui.vm.TransactionsViewModel

private object Routes {
    const val DASHBOARD = "dashboard"
    const val TRANSACTIONS = "transactions"
    const val PAYMENTS = "payments"
    const val INSIGHTS = "insights"
    const val BUDGETS = "budgets"
    const val REVIEW = "review"
    const val REVIEW_CENTRE = "review-centre"
    const val STATEMENT_IMPORT = "statement-import"
    const val SOURCES = "sources"
    const val SETTINGS = "settings"
    const val ACCOUNTS = "accounts"
    const val DIRECT_DEBITS = "directdebits"
    const val DIRECT_DEBIT_DETAIL = "directdebit"
    const val NOTIFICATIONS = "notifications"
    const val SYNC = "sync"
    const val ACCESS = "notificationaccess"
    const val DIAGNOSTICS = "diagnostics"
    const val BANK_CONNECTIONS = "bankconnections"
    const val BANK_CONNECTION_DETAIL = "bankconnection"
    const val SIGN_IN = "signin"
    const val CREATE = "create"
}

private data class Tab(val route: String, val label: String, val icon: ImageVector)

// Phase 4 primary navigation (spec §19): Home · Activity · Payments · Insights · Settings.
// Review and Approved sources remain reachable from Settings.
private val tabs = listOf(
    Tab(Routes.DASHBOARD, "Home", Icons.Filled.Home),
    Tab(Routes.TRANSACTIONS, "Activity", Icons.AutoMirrored.Filled.List),
    Tab(Routes.PAYMENTS, "Payments", Icons.Filled.Payments),
    Tab(Routes.INSIGHTS, "Insights", Icons.Filled.BarChart),
    Tab(Routes.SETTINGS, "Settings", Icons.Filled.Settings),
)

@Composable
fun AppRoot() {
    val session: SessionViewModel = containerViewModel { SessionViewModel(it.authRepository) }
    val state by session.state.collectAsStateWithLifecycle()
    when (state) {
        is SessionState.Loading -> SplashScreen()
        is SessionState.SignedOut -> AuthNav(session)
        is SessionState.SignedIn -> MainNav(session)
    }
}

@Composable
private fun AuthNav(session: SessionViewModel) {
    val nav = rememberNavController()
    NavHost(nav, startDestination = Routes.SIGN_IN) {
        composable(Routes.SIGN_IN) { SignInScreen(session, onCreateAccount = { nav.navigate(Routes.CREATE) }) }
        composable(Routes.CREATE) { CreateAccountScreen(session, onSignIn = { nav.popBackStack() }) }
    }
}

@Composable
private fun MainNav(session: SessionViewModel) {
    val nav = rememberNavController()
    Scaffold(
        bottomBar = {
            val backStack by nav.currentBackStackEntryAsState()
            val current = backStack?.destination?.route
            NavigationBar {
                tabs.forEach { tab ->
                    NavigationBarItem(
                        selected = current == tab.route,
                        onClick = {
                            nav.navigate(tab.route) {
                                popUpTo(Routes.DASHBOARD) { saveState = true }
                                launchSingleTop = true
                                restoreState = true
                            }
                        },
                        icon = { Icon(tab.icon, contentDescription = tab.label) },
                        label = { Text(tab.label) },
                    )
                }
            }
        },
    ) { padding ->
        NavHost(nav, startDestination = Routes.DASHBOARD, modifier = Modifier.padding(padding)) {
            composable(Routes.DASHBOARD) {
                HomeScreen(
                    home = containerViewModel { HomeViewModel(it.insightsRepository, it.dashboardRepository, it.transactionRepository) },
                    sync = containerViewModel { SyncViewModel(it.syncRepository, it.appPreferences, it.appContext) },
                    onCashFlow = { nav.navigate(Routes.INSIGHTS) },
                    onPayments = { nav.navigate(Routes.PAYMENTS) },
                    onBudgets = { nav.navigate(Routes.BUDGETS) },
                    onActivity = { nav.navigate(Routes.TRANSACTIONS) },
                    onAccounts = { nav.navigate(Routes.ACCOUNTS) },
                    onDirectDebits = { nav.navigate(Routes.DIRECT_DEBITS) },
                    onSyncStatus = { nav.navigate(Routes.SYNC) },
                    onNotifications = { nav.navigate(Routes.NOTIFICATIONS) },
                )
            }
            composable(Routes.TRANSACTIONS) {
                TransactionsScreen(containerViewModel { TransactionsViewModel(it.transactionRepository, it.dashboardRepository) })
            }
            composable(Routes.PAYMENTS) {
                PaymentsScreen(
                    vm = containerViewModel { PaymentsViewModel(it.insightsRepository) },
                    onOpen = { id -> nav.navigate("${Routes.DIRECT_DEBIT_DETAIL}/$id") },
                )
            }
            composable(Routes.INSIGHTS) {
                InsightsScreen(containerViewModel { InsightsViewModel(it.insightsRepository) })
            }
            composable(Routes.BUDGETS) {
                BudgetsScreen(containerViewModel { BudgetsViewModel(it.insightsRepository) })
            }
            composable(Routes.REVIEW) {
                ReviewImportsScreen(containerViewModel { ReviewViewModel(it.importRepository, it.authRepository, it.appContext) })
            }
            composable(Routes.STATEMENT_IMPORT) {
                StatementImportScreen(
                    vm = containerViewModel { StatementImportViewModel(it.statementRepository, it.dashboardRepository) },
                    onDone = { nav.popBackStack() },
                )
            }
            composable(Routes.REVIEW_CENTRE) {
                ReviewCentreScreen(containerViewModel { ReviewCentreViewModel(it.reviewRepository) })
            }
            composable(Routes.SOURCES) {
                SourcesTab(
                    vm = containerViewModel { SourcesViewModel(it.sourceRepository, it.importRepository, it.dashboardRepository, it.appPreferences) },
                    onAccess = { nav.navigate(Routes.ACCESS) },
                    onDashboard = { nav.navigate(Routes.DASHBOARD) },
                )
            }
            composable(Routes.SETTINGS) {
                SettingsScreen(
                    session = session,
                    settings = containerViewModel { SettingsViewModel(it.authRepository, it.db) },
                    onManageSources = { nav.navigate(Routes.SOURCES) },
                    onNotificationAccess = { nav.navigate(Routes.ACCESS) },
                    onDiagnostics = { nav.navigate(Routes.DIAGNOSTICS) },
                    onBankConnections = { nav.navigate(Routes.BANK_CONNECTIONS) },
                    debugRoute = DebugHooks.simulatorRoute,
                    onOpenDebug = { DebugHooks.simulatorRoute?.let { nav.navigate(it) } },
                    onReview = { nav.navigate(Routes.REVIEW) },
                    onManageBudgets = { nav.navigate(Routes.BUDGETS) },
                    onImportStatement = { nav.navigate(Routes.STATEMENT_IMPORT) },
                    onReviewCentre = { nav.navigate(Routes.REVIEW_CENTRE) },
                )
            }
            composable(Routes.BANK_CONNECTIONS) {
                BankConnectionsScreen(
                    vm = containerViewModel { BankConnectionsViewModel(it.bankConnectionRepository) },
                    onOpen = { id -> nav.navigate("${Routes.BANK_CONNECTION_DETAIL}/$id") },
                )
            }
            composable("${Routes.BANK_CONNECTION_DETAIL}/{id}") { entry ->
                val id = entry.arguments?.getString("id") ?: ""
                BankConnectionDetailScreen(
                    vm = containerViewModel { BankConnectionDetailViewModel(it.bankConnectionRepository, id) },
                    onDisconnected = { nav.popBackStack() },
                )
            }
            composable(Routes.ACCESS) { NotificationAccessScreen(onManageSources = { nav.navigate(Routes.SOURCES) }) }
            composable(Routes.DIAGNOSTICS) {
                DiagnosticsScreen(containerViewModel { DiagnosticsViewModel(it.diagnostics) })
            }
            composable(Routes.ACCOUNTS) { AccountsScreen(containerViewModel { OverviewViewModel(it.dashboardRepository) }) }
            composable(Routes.DIRECT_DEBITS) {
                DirectDebitsScreen(
                    vm = containerViewModel { DirectDebitsViewModel(it.directDebitRepository) },
                    onOpen = { id -> nav.navigate("${Routes.DIRECT_DEBIT_DETAIL}/$id") },
                )
            }
            composable("${Routes.DIRECT_DEBIT_DETAIL}/{id}") { entry ->
                val id = entry.arguments?.getString("id") ?: ""
                DirectDebitDetailScreen(containerViewModel { DirectDebitDetailViewModel(it.directDebitRepository, id) })
            }
            composable(Routes.NOTIFICATIONS) { NotificationsScreen() }
            composable(Routes.SYNC) {
                SyncStatusScreen(containerViewModel { SyncViewModel(it.syncRepository, it.appPreferences, it.appContext) })
            }
            addDebugDestinations(nav)
        }
    }
}

@Composable
private fun SourcesTab(vm: SourcesViewModel, onAccess: () -> Unit, onDashboard: () -> Unit) {
    val accepted by vm.disclosureAccepted.collectAsStateWithLifecycle()
    // Never parse before consent: the disclosure gates the whole source flow.
    if (!accepted) {
        DisclosureScreen(vm, onAgree = onAccess, onDecline = onDashboard)
    } else {
        ApprovedSourcesScreen(vm)
    }
}
