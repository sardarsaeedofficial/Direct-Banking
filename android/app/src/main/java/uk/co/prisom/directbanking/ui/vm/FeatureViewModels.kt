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

class TransactionsViewModel(
    private val repo: TransactionRepository,
    private val dashboardRepository: DashboardRepository,
) : ViewModel() {
    private val all = MutableStateFlow<Async<List<TransactionSummary>>>(Async.Loading)

    val filter = MutableStateFlow(ActivityFilter.ALL)
    val query = MutableStateFlow("")
    val accounts = MutableStateFlow<List<AccountSummary>>(emptyList())
    val selected = MutableStateFlow<TransactionSummary?>(null)

    /** The list after applying the active filter tab and the search query. */
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
        all.value = runCatching { repo.recent(200) }.fold({ Async.Success(it) }, { Async.Failure(errorText(it)) })
        runCatching { dashboardRepository.load().accounts }.onSuccess { accounts.value = it }
    }

    fun setFilter(f: ActivityFilter) { filter.value = f }
    fun setQuery(q: String) { query.value = q }
    fun open(t: TransactionSummary) { selected.value = t }
    fun close() { selected.value = null }

    /** Mark (or undo) "this is a transfer between my accounts", then refresh totals. */
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
        ActivityFilter.INCOME -> t.direction == "INCOME" && !t.isInternalTransfer
        ActivityFilter.SPENDING -> t.direction == "EXPENSE" && !t.isInternalTransfer
        ActivityFilter.INTERNAL -> t.isInternalTransfer
        ActivityFilter.DIRECT_DEBITS -> t.transactionType == "DIRECT_DEBIT" || t.transactionType == "STANDING_ORDER"
        ActivityFilter.TRANSFERS -> t.transactionType == "TRANSFER" || t.isInternalTransfer || t.direction == "TRANSFER"
        ActivityFilter.REFUNDS -> t.transactionType == "REFUND" || t.status == "REFUNDED"
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

    fun deleteLocalData() = viewModelScope.launch {
        _busy.value = true
        withContext(Dispatchers.IO) { db.clearAllTables() }
        _busy.value = false
    }

    fun revokeThisDevice(onDone: () -> Unit) = viewModelScope.launch {
        auth.logout(allDevices = false)
        onDone()
    }
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

class BankConnectionsViewModel(private val repo: uk.co.prisom.directbanking.data.repository.BankConnectionRepository) : ViewModel() {
    private val _state = MutableStateFlow<Async<List<uk.co.prisom.directbanking.data.remote.dto.BankConnectionDto>>>(Async.Loading)
    val state = _state.asStateFlow()
    val authUrl = MutableStateFlow<String?>(null)
    val starting = MutableStateFlow(false)

    init { refresh() }
    fun refresh() = viewModelScope.launch {
        _state.value = Async.Loading
        _state.value = runCatching { repo.list() }
            .recoverCatching { repo.cached() } // offline fallback
            .fold({ Async.Success(it) }, { Async.Failure(errorText(it)) })
    }

    /** Begin a connection; emits the authorization URL for the UI to open in a browser. */
    fun connectAnother() = viewModelScope.launch {
        starting.value = true
        runCatching { repo.start() }.onSuccess { (_, url) -> authUrl.value = url }
        starting.value = false
    }
    fun consumedAuthUrl() { authUrl.value = null }
}

class BankConnectionDetailViewModel(
    private val repo: uk.co.prisom.directbanking.data.repository.BankConnectionRepository,
    private val connectionId: String,
) : ViewModel() {
    private val _state = MutableStateFlow<Async<uk.co.prisom.directbanking.data.remote.dto.BankConnectionDetailResponse>>(Async.Loading)
    val state = _state.asStateFlow()
    val authUrl = MutableStateFlow<String?>(null)
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
        runCatching { repo.reauthorize(connectionId) }.onSuccess { authUrl.value = it }
    }
    fun disconnect(onDone: () -> Unit) = viewModelScope.launch {
        runCatching { repo.disconnect(connectionId) }.onSuccess { onDone() }
    }
    fun consumedAuthUrl() { authUrl.value = null }
}
