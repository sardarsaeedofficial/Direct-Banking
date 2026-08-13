package uk.co.prisom.directbanking.ui.vm

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import uk.co.prisom.directbanking.data.repository.DashboardRepository
import uk.co.prisom.directbanking.data.repository.ReviewRepository
import uk.co.prisom.directbanking.data.repository.StatementRepository
import uk.co.prisom.directbanking.data.remote.dto.ReviewCentreDto
import uk.co.prisom.directbanking.data.remote.dto.StatementImportResultDto
import uk.co.prisom.directbanking.data.remote.dto.StatementPreviewResponse
import uk.co.prisom.directbanking.domain.AccountSummary

private fun msg(t: Throwable): String = "Something went wrong — please try again"

/** The statement-import wizard stages (spec §17): select → parse → preview → confirm → results. */
sealed interface ImportStage {
    data object PickFile : ImportStage
    data object Uploading : ImportStage
    data class Preview(val preview: StatementPreviewResponse) : ImportStage
    data object Importing : ImportStage
    data class Result(val result: StatementImportResultDto, val filename: String) : ImportStage
    data class Failed(val message: String) : ImportStage
}

class StatementImportViewModel(
    private val statements: StatementRepository,
    private val dashboardRepo: DashboardRepository,
) : ViewModel() {
    val accounts = MutableStateFlow<List<AccountSummary>>(emptyList())
    val selectedAccountId = MutableStateFlow<String?>(null)
    val stage = MutableStateFlow<ImportStage>(ImportStage.PickFile)
    val excluded = MutableStateFlow<Set<Int>>(emptySet())

    private var importId: String? = null
    private var filename: String = ""

    init { loadAccounts() }

    private fun loadAccounts() = viewModelScope.launch {
        runCatching { dashboardRepo.load().accounts }.onSuccess { list ->
            accounts.value = list
            if (selectedAccountId.value == null) selectedAccountId.value = list.firstOrNull()?.id
        }
    }

    fun selectAccount(id: String) { selectedAccountId.value = id }

    /** Upload the picked file (already base64-encoded by the screen), then preview. */
    fun upload(name: String, fileType: String, contentBase64: String) = viewModelScope.launch {
        val accountId = selectedAccountId.value
        if (accountId == null) { stage.value = ImportStage.Failed("Choose an account first"); return@launch }
        filename = name
        excluded.value = emptySet()
        stage.value = ImportStage.Uploading
        stage.value = runCatching {
            val imp = statements.upload(accountId, name, fileType, contentBase64)
            importId = imp.id
            if (imp.status == "FAILED") {
                ImportStage.Failed(imp.error ?: "Unsupported statement format")
            } else {
                ImportStage.Preview(statements.preview(imp.id))
            }
        }.getOrElse { ImportStage.Failed(msg(it)) }
    }

    fun toggleExclude(rowIndex: Int) {
        excluded.value = excluded.value.toMutableSet().apply { if (!add(rowIndex)) remove(rowIndex) }
    }

    fun confirmImport() = viewModelScope.launch {
        val id = importId ?: return@launch
        stage.value = ImportStage.Importing
        stage.value = runCatching {
            ImportStage.Result(statements.import(id, excluded.value.toList()), filename)
        }.getOrElse { ImportStage.Failed(msg(it)) }
    }

    fun reset() {
        importId = null
        excluded.value = emptySet()
        stage.value = ImportStage.PickFile
    }
}

class ReviewCentreViewModel(private val repo: ReviewRepository) : ViewModel() {
    private val _state = MutableStateFlow<Async<ReviewCentreDto>>(Async.Loading)
    val state = _state.asStateFlow()
    val message = MutableStateFlow<String?>(null)

    init { refresh() }

    fun refresh() = viewModelScope.launch {
        _state.value = Async.Loading
        _state.value = runCatching { repo.centre() }.fold({ Async.Success(it) }, { Async.Failure(msg(it)) })
    }

    private fun act(label: String, block: suspend () -> Unit) = viewModelScope.launch {
        runCatching { block() }
            .onSuccess { message.value = label; refresh() }
            .onFailure { message.value = "Couldn't complete — try again" }
    }

    fun merge(id: String) = act("Merged") { repo.merge(id) }
    fun keepSeparate(id: String) = act("Kept separate") { repo.keepSeparate(id) }
    fun pair(aId: String, bId: String) = act("Paired as transfer") { repo.pair(aId, bId) }
    fun unpair(id: String) = act("Transfer unpaired") { repo.unpair(id) }
    fun consumeMessage() { message.value = null }
}
