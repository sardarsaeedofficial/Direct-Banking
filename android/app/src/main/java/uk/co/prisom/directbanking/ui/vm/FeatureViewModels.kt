package uk.co.prisom.directbanking.ui.vm

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uk.co.prisom.directbanking.data.DiagnosticsRepository
import uk.co.prisom.directbanking.data.DiagnosticsSnapshot
import uk.co.prisom.directbanking.data.local.AppPreferences
import uk.co.prisom.directbanking.data.local.db.DirectBankingDatabase
import uk.co.prisom.directbanking.data.local.db.ParsedImportEntity
import uk.co.prisom.directbanking.data.local.db.SourceWithCount
import uk.co.prisom.directbanking.data.repository.AuthRepository
import uk.co.prisom.directbanking.data.remote.dto.DdHistoryItemDto
import uk.co.prisom.directbanking.data.remote.dto.DdStatsDto
import uk.co.prisom.directbanking.data.remote.dto.DdUpdateRequest
import uk.co.prisom.directbanking.data.remote.dto.DirectDebitMandateDto
import uk.co.prisom.directbanking.data.repository.DashboardRepository
import uk.co.prisom.directbanking.data.repository.DirectDebitRepository
import uk.co.prisom.directbanking.data.repository.ImportRepository
import uk.co.prisom.directbanking.data.repository.SourceRepository
import uk.co.prisom.directbanking.data.repository.SyncRepository
import uk.co.prisom.directbanking.data.repository.TransactionRepository
import uk.co.prisom.directbanking.data.RefreshSignal
import uk.co.prisom.directbanking.domain.AccountSummary
import uk.co.prisom.directbanking.domain.DashboardData
import uk.co.prisom.directbanking.domain.TransactionSummary
import uk.co.prisom.directbanking.sync.SyncScheduler

/** Generic async UI state. */
sealed interface Async<out T> {
    data object Loading : Async<Nothing>
    data class Success<T>(val data: T) : Async<T>
    data class Failure(val message: String) : Async<Nothing>
}

private fun errorText(t: Throwable): String =
    t.message?.takeIf { it.isNotBlank() }?.let { "Couldn't load data" } ?: "Couldn't load data"

class DashboardViewModel(private val repo: DashboardRepository) : ViewModel() {
    private val _state = MutableStateFlow<Async<DashboardData>>(Async.Loading)
    val state = _state.asStateFlow()
    init {
        refresh()
        // Auto-refresh when an automatic import records a transaction.
        viewModelScope.launch {
            uk.co.prisom.directbanking.data.RefreshSignal.tick.drop(1).collect { refresh() }
        }
    }
    fun refresh() = viewModelScope.launch {
        _state.value = Async.Loading
        _state.value = runCatching { repo.load() }.fold({ Async.Success(it) }, { Async.Failure(errorText(it)) })
    }
}

/** Activity filter tabs (spec §7). */
enum class ActivityFilter(val label: String) {
    ALL("All"),
    INCOME("Income"),
    SPENDING("Spending"),
    INTERNAL("Internal transfers"),
    DIRECT_DEBITS("Direct Debits"),
    TRANSFERS("Transfers"),
    REFUNDS("Refunds"),
}

/**
 * The compact lifecycle selector (round-2 §3) — a SEPARATE axis from
 * [ActivityFilter] above, so existing Income/Spending/Internal-transfer/etc.
 * filtering keeps working exactly as before. This one is sent to the server
 * (it decides whether non-posted FinancialEvents are fetched at all), while
 * [ActivityFilter] and search continue to be applied client-side over
 * whatever page comes back.
 */
enum class ActivityLifecycleFilter(val label: String, val query: String?) {
    ALL("All", null),
    COMPLETED("Completed", "completed"),
    PENDING("Pending", "pending"),
    UPCOMING("Upcoming", "upcoming"),
    DECLINED_FAILED("Declined/Failed", "declined_failed"),
}

class TransactionsViewModel(
    private val repo: TransactionRepository,
    private val dashboardRepository: DashboardRepository,
) : ViewModel() {
    private val all = MutableStateFlow<Async<List<TransactionSummary>>>(Async.Loading)

    val filter = MutableStateFlow(ActivityFilter.ALL)
    val lifecycleFilter = MutableStateFlow(ActivityLifecycleFilter.ALL)
    val query = MutableStateFlow("")
    val accounts = MutableStateFlow<List<AccountSummary>>(emptyList())
    val selected = MutableStateFlow<TransactionSummary?>(null)

    /** The list after applying the active type filter tab and the search query
     *  (the lifecycle filter is already applied server-side, see [refresh]). */
    val state: StateFlow<Async<List<TransactionSummary>>> =
        combine(all, filter, query) { a, f, q ->
            when (a) {
                is Async.Success -> Async.Success(a.data.filter { matches(it, f) && searchMatches(it, q) })
                is Async.Loading -> Async.Loading
                is Async.Failure -> a
            }
        }.stateIn(viewModelScope, SharingStarted.Eagerly, Async.Loading)

    init { refresh() }

    fun refresh() = viewModelScope.launch {
        all.value = Async.Loading
        all.value = runCatching { repo.activity(lifecycle = lifecycleFilter.value.query, limit = 200) }
            .fold({ Async.Success(it) }, { Async.Failure(errorText(it)) })
        runCatching { dashboardRepository.load().accounts }.onSuccess { accounts.value = it }
    }

    fun setFilter(f: ActivityFilter) { filter.value = f }
    /** The lifecycle axis is server-side, so changing it re-fetches. */
    fun setLifecycleFilter(f: ActivityLifecycleFilter) { lifecycleFilter.value = f; refresh() }
    fun setQuery(q: String) { query.value = q }
    fun open(t: TransactionSummary) { selected.value = t }
    fun close() { selected.value = null }

    /** Mark (or undo) "this is a transfer between my accounts", then refresh totals.
     *  Only meaningful for a posted Transaction — never called for a
     *  FinancialEvent row (the detail screen hides the control for those). */
    fun setInternalTransfer(id: String, internal: Boolean, counterpartyAccountId: String? = null) = viewModelScope.launch {
        runCatching { repo.setInternalTransfer(id, internal, counterpartyAccountId) }.onSuccess { applyUpdate(it) }
    }

    fun setType(id: String, type: String) = viewModelScope.launch {
        runCatching { repo.setType(id, type) }.onSuccess { applyUpdate(it) }
    }

    private fun applyUpdate(updated: TransactionSummary) {
        val current = all.value
        if (current is Async.Success) {
            all.value = Async.Success(current.data.map { if (it.id == updated.id) updated else it })
        }
        if (selected.value?.id == updated.id) selected.value = updated
        RefreshSignal.trigger() // dashboard income/spending totals may have changed
    }

    private fun matches(t: TransactionSummary, f: ActivityFilter): Boolean = when (f) {
        ActivityFilter.ALL -> true
        ActivityFilter.INCOME -> t.direction == "INCOME" && !t.isInternalTransfer && !t.isCreditCardRepayment
        ActivityFilter.SPENDING -> t.direction == "EXPENSE" && !t.isInternalTransfer && !t.isCreditCardRepayment
        ActivityFilter.INTERNAL -> t.isInternalTransfer
        ActivityFilter.DIRECT_DEBITS -> t.transactionType == "DIRECT_DEBIT" || t.transactionType == "STANDING_ORDER" ||
            t.eventKind == "DIRECT_DEBIT" || t.eventKind == "STANDING_ORDER"
        ActivityFilter.TRANSFERS -> t.transactionType == "TRANSFER" || t.isInternalTransfer || t.direction == "TRANSFER"
        ActivityFilter.REFUNDS -> t.transactionType == "REFUND" || t.status == "REFUNDED" || t.lifecycle == "REFUNDED"
    }

    private fun searchMatches(t: TransactionSummary, q: String): Boolean {
        val needle = q.trim().lowercase()
        if (needle.isEmpty()) return true
        val haystack = listOfNotNull(
            t.description, t.merchant, t.senderName, t.recipientName, t.senderBankName, t.recipientBankName,
            t.account, t.category, t.paymentReference, t.notes,
            "%.2f".format(t.amountMinor / 100.0), t.amountMinor.toString(),
        ).joinToString(" ").lowercase()
        return haystack.contains(needle)
    }
}

/** Backs both the Accounts and Direct debits screens from bootstrap. */
class OverviewViewModel(private val repo: DashboardRepository) : ViewModel() {
    private val _state = MutableStateFlow<Async<DashboardData>>(Async.Loading)
    val state = _state.asStateFlow()
    init { refresh() }
    fun refresh() = viewModelScope.launch {
        _state.value = Async.Loading
        _state.value = runCatching { repo.load() }.fold({ Async.Success(it) }, { Async.Failure(errorText(it)) })
    }
}

class SyncViewModel(
    syncRepository: SyncRepository,
    appPreferences: AppPreferences,
    private val appContext: Context,
) : ViewModel() {
    val pendingCount: StateFlow<Int> =
        syncRepository.observePendingCount().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0)
    val lastSyncAtMillis: StateFlow<Long> =
        appPreferences.lastSyncAtMillis.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0L)

    fun syncNow() = SyncScheduler.syncNow(appContext)
}

data class RefAccount(val id: String, val name: String)
data class RefCategory(val id: String, val name: String)
data class ReviewRefData(val accounts: List<RefAccount>, val categories: List<RefCategory>)

class ReviewViewModel(
    private val importRepository: ImportRepository,
    private val authRepository: AuthRepository,
    private val appContext: Context,
) : ViewModel() {
    val queue: StateFlow<List<ParsedImportEntity>> =
        importRepository.observeReviewQueue().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    private val _ref = MutableStateFlow<ReviewRefData?>(null)
    val ref = _ref.asStateFlow()

    init { loadRef() }

    private fun loadRef() = viewModelScope.launch {
        runCatching { authRepository.bootstrap() }.onSuccess { b ->
            _ref.value = ReviewRefData(
                accounts = b.accounts.map { RefAccount(it.id, it.nickname) },
                categories = b.categories.map { RefCategory(it.id, it.name) },
            )
        }
    }

    fun approve(
        fingerprint: String,
        accountId: String,
        categoryId: String?,
        amountMinor: Long?,
        direction: String?,
        merchant: String?,
        occurredAtMillis: Long?,
        notes: String?,
    ) = viewModelScope.launch {
        importRepository.approve(fingerprint, accountId, categoryId, amountMinor, direction, merchant, occurredAtMillis, notes)
        SyncScheduler.syncNow(appContext)
    }

    fun reject(fingerprint: String) = viewModelScope.launch {
        importRepository.reject(fingerprint)
        SyncScheduler.syncNow(appContext)
    }

    fun ignoreSource(packageName: String) = viewModelScope.launch { importRepository.markSourceIgnored(packageName) }
}

class SourcesViewModel(
    private val sourceRepository: SourceRepository,
    private val importRepository: ImportRepository,
    private val dashboardRepository: DashboardRepository,
    private val appPreferences: AppPreferences,
) : ViewModel() {
    val sources: StateFlow<List<SourceWithCount>> =
        sourceRepository.observeSourcesWithCounts().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())
    val disclosureAccepted: StateFlow<Boolean> =
        appPreferences.disclosureAccepted.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), false)

    private val _accounts = MutableStateFlow<List<uk.co.prisom.directbanking.data.repository.AccountRef>>(emptyList())
    val accounts = _accounts.asStateFlow()

    init { loadAccountsAndAutoMap() }

    private fun loadAccountsAndAutoMap() = viewModelScope.launch {
        runCatching { dashboardRepository.load() }.onSuccess { data ->
            val refs = data.accounts.map { uk.co.prisom.directbanking.data.repository.AccountRef(it.id, it.nickname, it.bankName) }
            _accounts.value = refs
            sourceRepository.autoMapAccounts(refs) // map trusted sources with a clear single match
        }
    }

    /** Approve an unknown source, map an account, and reprocess its latest notification. */
    fun approve(pkg: String, accountId: String?, label: String) = viewModelScope.launch {
        sourceRepository.approveWithAccount(pkg, accountId)
        importRepository.reprocessLatest(pkg, label)
    }

    fun setAutoImport(pkg: String, enabled: Boolean) = viewModelScope.launch { sourceRepository.setAutoImport(pkg, enabled) }
    fun setRequireReview(pkg: String, required: Boolean) = viewModelScope.launch { sourceRepository.setRequireReview(pkg, required) }
    fun setLinkedAccount(pkg: String, accountId: String, label: String) = viewModelScope.launch {
        sourceRepository.setLinkedAccount(pkg, accountId)
        importRepository.reprocessLatest(pkg, label)
    }

    fun setApproved(pkg: String, approved: Boolean) = viewModelScope.launch { sourceRepository.setApproved(pkg, approved) }
    fun ignore(pkg: String) = viewModelScope.launch { sourceRepository.setIgnored(pkg, true) }
    fun acceptDisclosure() = viewModelScope.launch { appPreferences.setDisclosureAccepted(true) }
    fun declineDisclosure() = viewModelScope.launch { appPreferences.setDisclosureAccepted(false) }
}

class DiagnosticsViewModel(
    diagnostics: DiagnosticsRepository,
) : ViewModel() {
    val snapshot: StateFlow<DiagnosticsSnapshot> = diagnostics.state

    /** User-initiated scan of currently visible notifications. Returns false if the listener isn't bound. */
    fun scanVisibleNotifications(): Boolean =
        uk.co.prisom.directbanking.notifications.BankNotificationListenerService.requestScan()
}

class SettingsViewModel(
    private val auth: AuthRepository,
    private val db: DirectBankingDatabase,
) : ViewModel() {
    private val _busy = MutableStateFlow(false)
    val busy = _busy.asStateFlow()
    // Final release completion (§3): null = no attempt yet / dismissed,
    // otherwise the reason deletion could not complete (never leaks the
    // server's exact error text — see errorText()).
    private val _deleteAccountError = MutableStateFlow<String?>(null)
    val deleteAccountError = _deleteAccountError.asStateFlow()

    fun deleteLocalData() = viewModelScope.launch {
        _busy.value = true
        withContext(Dispatchers.IO) { db.clearAllTables() }
        _busy.value = false
    }

    fun revokeThisDevice(onDone: () -> Unit) = viewModelScope.launch {
        auth.logout(allDevices = false)
        onDone()
    }

    /**
     * Permanently delete the account. The user must have already typed the
     * "DELETE" confirmation in the UI before this is called (see
     * DeleteAccountDialog) — the server independently re-enforces the same
     * confirmation phrase, so intent is proven on both ends.
     *
     * On success: local credentials are cleared (AuthRepository.deleteAccount)
     * and every cached Room table is wiped, so no previous account data
     * remains visible locally even offline; onDeleted() then returns the
     * user to login/onboarding.
     */
    fun deleteAccount(password: String, onDeleted: () -> Unit) = viewModelScope.launch {
        _busy.value = true
        _deleteAccountError.value = null
        auth.deleteAccount(password)
            .onSuccess {
                withContext(Dispatchers.IO) { db.clearAllTables() }
                _busy.value = false
                onDeleted()
            }
            .onFailure {
                _busy.value = false
                _deleteAccountError.value = if (it is retrofit2.HttpException && it.code() == 401) {
                    "Incorrect password"
                } else {
                    "Couldn't delete your account — please try again."
                }
            }
    }

    fun consumedDeleteAccountError() { _deleteAccountError.value = null }
}

/** Direct Debits overview tabs (spec §12). */
enum class DdTab(val label: String) { ACTIVE("Active"), UPCOMING("Upcoming"), ATTENTION("Attention"), CANCELLED("Cancelled") }
enum class DdSort(val label: String, val api: String) { NEXT("Next payment", "next"), COMPANY("Company", "company"), AMOUNT("Amount", "amount") }

class DirectDebitsViewModel(private val repo: DirectDebitRepository) : ViewModel() {
    private val all = MutableStateFlow<Async<List<DirectDebitMandateDto>>>(Async.Loading)
    val tab = MutableStateFlow(DdTab.ACTIVE)
    val query = MutableStateFlow("")
    val sort = MutableStateFlow(DdSort.NEXT)

    val state: StateFlow<Async<List<DirectDebitMandateDto>>> =
        combine(all, tab, query) { a, t, q ->
            when (a) {
                is Async.Success -> Async.Success(a.data.filter { matches(it, t) && searchMatches(it, q) })
                is Async.Loading -> Async.Loading
                is Async.Failure -> a
            }
        }.stateIn(viewModelScope, SharingStarted.Eagerly, Async.Loading)

    init { refresh() }

    fun refresh() = viewModelScope.launch {
        all.value = Async.Loading
        all.value = runCatching { repo.list(sort = sort.value.api) }.fold({ Async.Success(it) }, { Async.Failure(errorText(it)) })
    }
    fun setTab(t: DdTab) { tab.value = t }
    fun setQuery(q: String) { query.value = q }
    fun setSort(s: DdSort) { sort.value = s; refresh() }

    private fun matches(m: DirectDebitMandateDto, t: DdTab): Boolean = when (t) {
        DdTab.ACTIVE -> m.status == "ACTIVE"
        DdTab.UPCOMING -> m.status == "ACTIVE" && m.nextExpectedAt != null
        DdTab.ATTENTION -> m.status == "UNKNOWN" || m.status == "PAUSED"
        DdTab.CANCELLED -> m.status == "CANCELLED"
    }
    private fun searchMatches(m: DirectDebitMandateDto, q: String): Boolean {
        val needle = q.trim().lowercase()
        return needle.isEmpty() || m.companyName.lowercase().contains(needle)
    }
}

data class DdDetail(val mandate: DirectDebitMandateDto, val stats: DdStatsDto, val history: List<DdHistoryItemDto>)

class DirectDebitDetailViewModel(private val repo: DirectDebitRepository, private val mandateId: String) : ViewModel() {
    private val _state = MutableStateFlow<Async<DdDetail>>(Async.Loading)
    val state = _state.asStateFlow()
    init { load() }
    fun load() = viewModelScope.launch {
        _state.value = Async.Loading
        _state.value = runCatching {
            val detail = repo.detail(mandateId)
            val history = repo.history(mandateId)
            DdDetail(detail.mandate, detail.stats, history)
        }.fold({ Async.Success(it) }, { Async.Failure(errorText(it)) })
    }
    fun update(body: DdUpdateRequest) = viewModelScope.launch {
        runCatching { repo.update(mandateId, body) }.onSuccess { load() }
        RefreshSignal.trigger()
    }
}

/** How the client should complete a connection journey. */
sealed interface ConnectAction {
    data class OpenBrowser(val url: String) : ConnectAction // hosted_url providers (TrueLayer)
    data class LaunchPlaid(val connectionId: String, val linkToken: String) : ConnectAction // link_token providers (Plaid)
}

class BankConnectionsViewModel(private val repo: uk.co.prisom.directbanking.data.repository.BankConnectionRepository) : ViewModel() {
    private val _state = MutableStateFlow<Async<List<uk.co.prisom.directbanking.data.remote.dto.BankConnectionDto>>>(Async.Loading)
    val state = _state.asStateFlow()
    val action = MutableStateFlow<ConnectAction?>(null)
    val starting = MutableStateFlow(false)
    // Financial Event Intelligence: null while loading, then the safe/non-secret
    // readiness state so the screen can say exactly why linking a bank isn't
    // available yet ("not enabled" vs "not configured") instead of only
    // surfacing a failure after the user taps Connect.
    private val _readiness = MutableStateFlow<uk.co.prisom.directbanking.data.remote.dto.BankConnectionsReadiness?>(null)
    val readiness = _readiness.asStateFlow()
    // Final release completion: surfaces the outcome of finishing a Plaid Link
    // journey — Plaid Link itself succeeding only means the user completed
    // authorization with their bank; the server-side public-token exchange can
    // still fail (network, EXCHANGE_FAILED), and without this the screen
    // silently showed nothing at all, leaving the user unsure whether their
    // bank connected.
    val message = MutableStateFlow<String?>(null)

    init { refresh(); loadReadiness() }
    fun refresh() = viewModelScope.launch {
        _state.value = Async.Loading
        _state.value = runCatching { repo.list() }
            .recoverCatching { repo.cached() } // offline fallback
            .fold({ Async.Success(it) }, { Async.Failure(errorText(it)) })
    }
    private fun loadReadiness() = viewModelScope.launch {
        _readiness.value = runCatching { repo.readiness() }.getOrNull()
    }

    /** Begin a connection; emit the provider-specific completion action. */
    fun connectAnother() = viewModelScope.launch {
        starting.value = true
        runCatching { repo.start() }.onSuccess { r ->
            action.value = if (r.mode == "link_token" && r.linkToken != null) ConnectAction.LaunchPlaid(r.connectionId, r.linkToken)
            else r.authorizationUrl?.let { ConnectAction.OpenBrowser(it) }
        }.onFailure { message.value = "Couldn't start connecting your bank — please try again." }
        starting.value = false
    }

    /** Finish a Plaid Link journey by exchanging the public token, then refresh. */
    fun completePlaid(connectionId: String, publicToken: String) = viewModelScope.launch {
        runCatching { repo.complete(connectionId, publicToken) }
            .onSuccess { ok -> message.value = if (ok) null else "Couldn't connect your bank — please try again."; refresh() }
            .onFailure { message.value = "Couldn't connect your bank — please try again." }
    }
    /** The user exited Plaid Link without finishing — no connection is completed. */
    fun onLinkCancelled() { refresh() }
    fun consumedAction() { action.value = null }
    fun consumedMessage() { message.value = null }
}

class BankConnectionDetailViewModel(
    private val repo: uk.co.prisom.directbanking.data.repository.BankConnectionRepository,
    private val connectionId: String,
) : ViewModel() {
    private val _state = MutableStateFlow<Async<uk.co.prisom.directbanking.data.remote.dto.BankConnectionDetailResponse>>(Async.Loading)
    val state = _state.asStateFlow()
    val action = MutableStateFlow<ConnectAction?>(null)
    val message = MutableStateFlow<String?>(null)

    init { load() }
    fun load() = viewModelScope.launch {
        _state.value = Async.Loading
        _state.value = runCatching { repo.detail(connectionId) }.fold({ Async.Success(it) }, { Async.Failure(errorText(it)) })
    }
    fun syncNow() = viewModelScope.launch {
        message.value = "Syncing…"
        runCatching { repo.sync(connectionId) }
            .onSuccess { message.value = "Synced ${it.imported + it.matched} transactions"; load() }
            .onFailure { message.value = "Sync failed — will retry later" }
    }
    fun reconnect() = viewModelScope.launch {
        runCatching { repo.reauthorize(connectionId) }.onSuccess { r ->
            action.value = if (r.mode == "link_token" && r.linkToken != null) ConnectAction.LaunchPlaid(r.connectionId, r.linkToken)
            else r.authorizationUrl?.let { ConnectAction.OpenBrowser(it) }
        }
    }
    fun completePlaid(publicToken: String) = viewModelScope.launch {
        runCatching { repo.complete(connectionId, publicToken) }
            .onSuccess { ok -> message.value = if (ok) "Reconnected" else "Couldn't reconnect your bank — please try again."; load() }
            .onFailure { message.value = "Couldn't reconnect your bank — please try again." }
    }
    fun onLinkCancelled() { message.value = "Reconnect cancelled"; load() }
    fun disconnect(onDone: () -> Unit) = viewModelScope.launch {
        runCatching { repo.disconnect(connectionId) }.onSuccess { onDone() }
    }
    fun consumedAction() { action.value = null }
}
