package uk.co.prisom.directbanking.ui.vm

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uk.co.prisom.directbanking.data.local.AppPreferences
import uk.co.prisom.directbanking.data.local.db.DirectBankingDatabase
import uk.co.prisom.directbanking.data.local.db.ParsedImportEntity
import uk.co.prisom.directbanking.data.local.db.SourceWithCount
import uk.co.prisom.directbanking.data.repository.AuthRepository
import uk.co.prisom.directbanking.data.repository.DashboardRepository
import uk.co.prisom.directbanking.data.repository.ImportRepository
import uk.co.prisom.directbanking.data.repository.SourceRepository
import uk.co.prisom.directbanking.data.repository.SyncRepository
import uk.co.prisom.directbanking.data.repository.TransactionRepository
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
    init { refresh() }
    fun refresh() = viewModelScope.launch {
        _state.value = Async.Loading
        _state.value = runCatching { repo.load() }.fold({ Async.Success(it) }, { Async.Failure(errorText(it)) })
    }
}

class TransactionsViewModel(private val repo: TransactionRepository) : ViewModel() {
    private val _state = MutableStateFlow<Async<List<TransactionSummary>>>(Async.Loading)
    val state = _state.asStateFlow()
    init { refresh() }
    fun refresh() = viewModelScope.launch {
        _state.value = Async.Loading
        _state.value = runCatching { repo.recent(100) }.fold({ Async.Success(it) }, { Async.Failure(errorText(it)) })
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
    private val appPreferences: AppPreferences,
) : ViewModel() {
    val sources: StateFlow<List<SourceWithCount>> =
        sourceRepository.observeSourcesWithCounts().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())
    val disclosureAccepted: StateFlow<Boolean> =
        appPreferences.disclosureAccepted.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), false)

    fun setApproved(pkg: String, approved: Boolean) = viewModelScope.launch { sourceRepository.setApproved(pkg, approved) }
    fun ignore(pkg: String) = viewModelScope.launch { sourceRepository.setIgnored(pkg, true) }
    fun acceptDisclosure() = viewModelScope.launch { appPreferences.setDisclosureAccepted(true) }
    fun declineDisclosure() = viewModelScope.launch { appPreferences.setDisclosureAccepted(false) }
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
