package uk.co.prisom.directbanking.ui.vm

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import uk.co.prisom.directbanking.data.RefreshSignal
import uk.co.prisom.directbanking.data.repository.Cached
import uk.co.prisom.directbanking.data.repository.DashboardRepository
import uk.co.prisom.directbanking.data.repository.InsightsRepository
import uk.co.prisom.directbanking.data.repository.TransactionRepository
import uk.co.prisom.directbanking.domain.AccountSummary
import uk.co.prisom.directbanking.domain.BankSyncStatus
import uk.co.prisom.directbanking.domain.TransactionSummary
import uk.co.prisom.directbanking.data.remote.dto.BudgetCreateRequest
import uk.co.prisom.directbanking.data.remote.dto.BudgetProgressDto
import uk.co.prisom.directbanking.data.remote.dto.CashFlowForecastDto
import uk.co.prisom.directbanking.data.remote.dto.CategoryBreakdownDto
import uk.co.prisom.directbanking.data.remote.dto.CategoryItemDto
import uk.co.prisom.directbanking.data.remote.dto.InsightsOverviewDto
import uk.co.prisom.directbanking.data.remote.dto.NetWorthDto
import uk.co.prisom.directbanking.data.remote.dto.RecurringPaymentsViewDto
import uk.co.prisom.directbanking.data.remote.dto.SubscriptionSuggestionDto
import uk.co.prisom.directbanking.data.remote.dto.TopMerchantsDto

private fun err(t: Throwable): String = "Couldn't load data"

/** The insights sub-screens (spec §19 navigation). */
enum class InsightsTab(val label: String) {
    OVERVIEW("Overview"),
    CATEGORIES("Categories"),
    MERCHANTS("Merchants"),
    CASH_FLOW("Cash flow"),
    NET_WORTH("Net worth"),
}

class InsightsViewModel(private val repo: InsightsRepository) : ViewModel() {
    val tab = MutableStateFlow(InsightsTab.OVERVIEW)

    private val _overview = MutableStateFlow<Async<Cached<InsightsOverviewDto>>>(Async.Loading)
    val overview = _overview.asStateFlow()

    private val _categories = MutableStateFlow<Async<CategoryBreakdownDto>>(Async.Loading)
    val categories = _categories.asStateFlow()

    private val _merchants = MutableStateFlow<Async<TopMerchantsDto>>(Async.Loading)
    val merchants = _merchants.asStateFlow()

    private val _cashFlow = MutableStateFlow<Async<CashFlowForecastDto>>(Async.Loading)
    val cashFlow = _cashFlow.asStateFlow()

    private val _netWorth = MutableStateFlow<Async<NetWorthDto>>(Async.Loading)
    val netWorth = _netWorth.asStateFlow()

    /** Period for the category breakdown (week/month/year). */
    val categoryPeriod = MutableStateFlow("month")

    init { loadOverview() }

    fun setTab(t: InsightsTab) {
        tab.value = t
        when (t) {
            InsightsTab.OVERVIEW -> if (_overview.value !is Async.Success) loadOverview()
            InsightsTab.CATEGORIES -> if (_categories.value !is Async.Success) loadCategories()
            InsightsTab.MERCHANTS -> if (_merchants.value !is Async.Success) loadMerchants()
            InsightsTab.CASH_FLOW -> if (_cashFlow.value !is Async.Success) loadCashFlow()
            InsightsTab.NET_WORTH -> if (_netWorth.value !is Async.Success) loadNetWorth()
        }
    }

    fun loadOverview() = viewModelScope.launch {
        _overview.value = Async.Loading
        _overview.value = runCatching { repo.overview() }.fold({ Async.Success(it) }, { Async.Failure(err(it)) })
    }

    fun setCategoryPeriod(p: String) { categoryPeriod.value = p; loadCategories() }

    fun loadCategories() = viewModelScope.launch {
        _categories.value = Async.Loading
        _categories.value = runCatching { repo.categories(categoryPeriod.value) }.fold({ Async.Success(it) }, { Async.Failure(err(it)) })
    }

    fun loadMerchants() = viewModelScope.launch {
        _merchants.value = Async.Loading
        _merchants.value = runCatching { repo.merchants() }.fold({ Async.Success(it) }, { Async.Failure(err(it)) })
    }

    fun loadCashFlow() = viewModelScope.launch {
        _cashFlow.value = Async.Loading
        _cashFlow.value = runCatching { repo.cashFlow() }.fold({ Async.Success(it) }, { Async.Failure(err(it)) })
    }

    fun loadNetWorth() = viewModelScope.launch {
        _netWorth.value = Async.Loading
        _netWorth.value = runCatching { repo.netWorth() }.fold({ Async.Success(it) }, { Async.Failure(err(it)) })
    }
}

class BudgetsViewModel(private val repo: InsightsRepository) : ViewModel() {
    private val _state = MutableStateFlow<Async<List<BudgetProgressDto>>>(Async.Loading)
    val state = _state.asStateFlow()

    private val _categories = MutableStateFlow<List<CategoryItemDto>>(emptyList())
    val categories = _categories.asStateFlow()

    val showCreate = MutableStateFlow(false)

    init { refresh(); loadCategories() }

    fun refresh() = viewModelScope.launch {
        _state.value = Async.Loading
        _state.value = runCatching { repo.budgets() }.fold({ Async.Success(it) }, { Async.Failure(err(it)) })
    }

    private fun loadCategories() = viewModelScope.launch {
        runCatching { repo.categoryList() }.onSuccess { list -> _categories.value = list.filter { it.parentId == null } }
    }

    fun openCreate() { showCreate.value = true }
    fun dismissCreate() { showCreate.value = false }

    fun create(name: String, categoryId: String?, limitMinor: Long) = viewModelScope.launch {
        val body = BudgetCreateRequest(
            name = name,
            categoryId = categoryId,
            limitMinor = limitMinor,
            startDate = java.time.LocalDate.now().withDayOfMonth(1).toString(),
        )
        runCatching { repo.createBudget(body) }.onSuccess { showCreate.value = false; refresh() }
    }

    fun delete(id: String) = viewModelScope.launch {
        runCatching { repo.deleteBudget(id) }.onSuccess { refresh() }
    }
}

/** Best-effort extras that complement the cached insights overview on Home. */
data class HomeExtras(
    val displayName: String? = null,
    val bankSync: BankSyncStatus = BankSyncStatus(),
    val accounts: List<AccountSummary> = emptyList(),
    val recent: List<TransactionSummary> = emptyList(),
)

/**
 * Composes the redesigned Home: the insights overview (cached in Room v7, so it
 * renders offline with a staleness flag) plus best-effort extras (connected-bank
 * status, per-currency account totals, a short recent-activity list). The overview
 * is the primary source and never blanks; extras degrade silently when offline.
 */
class HomeViewModel(
    private val insights: InsightsRepository,
    private val dashboardRepo: DashboardRepository,
    private val txnRepo: TransactionRepository,
) : ViewModel() {
    private val _overview = MutableStateFlow<Async<Cached<InsightsOverviewDto>>>(Async.Loading)
    val overview = _overview.asStateFlow()

    private val _extras = MutableStateFlow(HomeExtras())
    val extras = _extras.asStateFlow()

    init {
        refresh()
        // Refresh when an auto-import records a transaction (totals may change).
        viewModelScope.launch { RefreshSignal.tick.drop(1).collect { refresh() } }
    }

    fun refresh() = viewModelScope.launch {
        _overview.value = Async.Loading
        _overview.value = runCatching { insights.overview() }.fold({ Async.Success(it) }, { Async.Failure(err(it)) })
        // Extras are best-effort: offline failures must not blank the screen.
        val dash = runCatching { dashboardRepo.load() }.getOrNull()
        val recent = runCatching { txnRepo.recent(8) }.getOrNull().orEmpty()
        _extras.value = HomeExtras(
            displayName = dash?.displayName,
            bankSync = dash?.bankSync ?: BankSyncStatus(),
            accounts = dash?.accounts.orEmpty(),
            // Home shows only a few, and never internal transfers.
            recent = recent.filter { !it.isInternalTransfer }.take(5),
        )
    }
}

class PaymentsViewModel(private val repo: InsightsRepository) : ViewModel() {
    private val _state = MutableStateFlow<Async<RecurringPaymentsViewDto>>(Async.Loading)
    val state = _state.asStateFlow()

    private val _suggestions = MutableStateFlow<List<SubscriptionSuggestionDto>>(emptyList())
    val suggestions = _suggestions.asStateFlow()

    init { refresh() }

    fun refresh() = viewModelScope.launch {
        _state.value = Async.Loading
        _state.value = runCatching { repo.recurring() }.fold({ Async.Success(it) }, { Async.Failure(err(it)) })
        runCatching { repo.recurringSuggestions() }.onSuccess { _suggestions.value = it }
    }
}
