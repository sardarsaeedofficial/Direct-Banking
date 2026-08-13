package uk.co.prisom.directbanking.data

import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import uk.co.prisom.directbanking.data.remote.dto.ReviewCentreDto
import uk.co.prisom.directbanking.data.remote.dto.ReviewCounts
import uk.co.prisom.directbanking.data.remote.dto.StatementImportDto
import uk.co.prisom.directbanking.data.remote.dto.StatementImportResultDto
import uk.co.prisom.directbanking.data.remote.dto.StatementPreviewResponse
import uk.co.prisom.directbanking.data.remote.dto.StatementPreviewRow
import uk.co.prisom.directbanking.data.remote.dto.StatementPreviewSummary
import uk.co.prisom.directbanking.data.repository.DashboardRepository
import uk.co.prisom.directbanking.data.repository.ReviewRepository
import uk.co.prisom.directbanking.data.repository.StatementRepository
import uk.co.prisom.directbanking.ui.vm.Async
import uk.co.prisom.directbanking.ui.vm.ImportStage
import uk.co.prisom.directbanking.ui.vm.ReviewCentreViewModel
import uk.co.prisom.directbanking.ui.vm.StatementImportViewModel

class Phase5ViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private lateinit var statements: StatementRepository
    private lateinit var dashboard: DashboardRepository
    private lateinit var review: ReviewRepository

    @Before fun setUp() {
        Dispatchers.setMain(dispatcher)
        statements = mockk(relaxed = true)
        dashboard = mockk(relaxed = true)
        review = mockk(relaxed = true)
    }

    @After fun tearDown() = Dispatchers.resetMain()

    private fun previewOf(vararg statuses: String) = StatementPreviewResponse(
        import = StatementImportDto(id = "imp1", status = "PARSED"),
        summary = StatementPreviewSummary(found = statuses.size, newCount = statuses.count { it == "NEW" }, reviewCount = statuses.count { it == "REVIEW" }),
        rows = statuses.mapIndexed { i, st -> StatementPreviewRow(id = "r$i", rowIndex = i + 1, amountMinor = 100, reconStatus = st) },
    )

    @Test
    fun `upload advances to preview`() = runTest(dispatcher.scheduler) {
        coEvery { statements.upload(any(), any(), any(), any(), any()) } returns StatementImportDto(id = "imp1", status = "PARSED")
        coEvery { statements.preview("imp1") } returns previewOf("NEW", "NEW", "REVIEW")
        val vm = StatementImportViewModel(statements, dashboard)
        vm.selectAccount("acc1")
        vm.upload("june.csv", "CSV", "YmFzZTY0")
        advanceUntilIdle()
        val stage = vm.stage.value
        assertTrue(stage is ImportStage.Preview)
        assertEquals(3, (stage as ImportStage.Preview).preview.summary.found)
    }

    @Test
    fun `a FAILED import surfaces the failed stage`() = runTest(dispatcher.scheduler) {
        coEvery { statements.upload(any(), any(), any(), any(), any()) } returns StatementImportDto(id = "imp2", status = "FAILED", error = "Unsupported statement format")
        val vm = StatementImportViewModel(statements, dashboard)
        vm.selectAccount("acc1")
        vm.upload("scan.pdf", "PDF", "YmFzZTY0")
        advanceUntilIdle()
        assertTrue(vm.stage.value is ImportStage.Failed)
    }

    @Test
    fun `confirm import produces the result stage and excludes rows`() = runTest(dispatcher.scheduler) {
        coEvery { statements.upload(any(), any(), any(), any(), any()) } returns StatementImportDto(id = "imp1", status = "PARSED")
        coEvery { statements.preview("imp1") } returns previewOf("NEW", "NEW", "NEW")
        coEvery { statements.import("imp1", any(), any()) } returns StatementImportResultDto(imported = 2, skipped = 1, total = 3)
        val vm = StatementImportViewModel(statements, dashboard)
        vm.selectAccount("acc1")
        vm.upload("june.csv", "CSV", "YmFzZTY0")
        advanceUntilIdle()
        vm.toggleExclude(2)
        vm.confirmImport()
        advanceUntilIdle()
        val stage = vm.stage.value
        assertTrue(stage is ImportStage.Result)
        assertEquals(2, (stage as ImportStage.Result).result.imported)
        coVerify { statements.import("imp1", listOf(2), false) }
    }

    @Test
    fun `review centre loads and merge triggers a refresh`() = runTest(dispatcher.scheduler) {
        coEvery { review.centre() } returns ReviewCentreDto(counts = ReviewCounts(possibleDuplicates = 1))
        val vm = ReviewCentreViewModel(review)
        advanceUntilIdle()
        assertTrue(vm.state.value is Async.Success)
        vm.merge("txn1")
        advanceUntilIdle()
        coVerify { review.merge("txn1") }
        coVerify(atLeast = 2) { review.centre() } // initial load + refresh after merge
    }

    @Test
    fun `keep separate and unpair call through to the repository`() = runTest(dispatcher.scheduler) {
        coEvery { review.centre() } returns ReviewCentreDto()
        val vm = ReviewCentreViewModel(review)
        advanceUntilIdle()
        vm.keepSeparate("txnA")
        vm.unpair("txnB")
        advanceUntilIdle()
        coVerify { review.keepSeparate("txnA") }
        coVerify { review.unpair("txnB") }
    }
}
