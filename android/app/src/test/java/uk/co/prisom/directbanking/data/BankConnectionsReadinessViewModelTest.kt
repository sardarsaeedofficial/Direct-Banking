package uk.co.prisom.directbanking.data

import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import uk.co.prisom.directbanking.data.remote.dto.BankConnectionsReadiness
import uk.co.prisom.directbanking.data.repository.BankConnectionRepository
import uk.co.prisom.directbanking.ui.vm.BankConnectionsViewModel

// Financial Event Intelligence (§40/§45): Bank Connections readiness must be
// loaded up front and reflected accurately, so the screen never just looks
// broken when Open Banking is disabled or misconfigured.
class BankConnectionsReadinessViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private lateinit var repo: BankConnectionRepository

    @Before fun setUp() {
        Dispatchers.setMain(dispatcher)
        repo = mockk(relaxed = true)
        coEvery { repo.list() } returns emptyList()
    }

    @After fun tearDown() = Dispatchers.resetMain()

    @Test
    fun `disabled readiness is exposed as-is for the screen to interpret`() = runTest(dispatcher.scheduler) {
        coEvery { repo.readiness() } returns BankConnectionsReadiness(enabled = false, provider = "plaid", environment = "sandbox", configured = false, missing = emptyList())
        val vm = BankConnectionsViewModel(repo)
        advanceUntilIdle()
        val r = vm.readiness.value
        assertEquals(false, r?.enabled)
        assertEquals(false, r?.configured)
    }

    @Test
    fun `enabled but missing configuration reports the missing variable names, never a value`() = runTest(dispatcher.scheduler) {
        coEvery { repo.readiness() } returns BankConnectionsReadiness(
            enabled = true, provider = "plaid", environment = "sandbox", configured = false,
            missing = listOf("PLAID_CLIENT_ID", "PLAID_SECRET"),
        )
        val vm = BankConnectionsViewModel(repo)
        advanceUntilIdle()
        val r = vm.readiness.value
        assertEquals(true, r?.enabled)
        assertFalse(r!!.configured)
        assertEquals(listOf("PLAID_CLIENT_ID", "PLAID_SECRET"), r.missing)
    }

    @Test
    fun `fully configured readiness reports no missing variables`() = runTest(dispatcher.scheduler) {
        coEvery { repo.readiness() } returns BankConnectionsReadiness(enabled = true, provider = "plaid", environment = "sandbox", configured = true, missing = emptyList())
        val vm = BankConnectionsViewModel(repo)
        advanceUntilIdle()
        val r = vm.readiness.value
        assertEquals(true, r?.configured)
        assertEquals(emptyList<String>(), r?.missing)
    }

    @Test
    fun `a readiness call failure never crashes the view model — it simply stays unknown`() = runTest(dispatcher.scheduler) {
        coEvery { repo.readiness() } throws RuntimeException("network error")
        val vm = BankConnectionsViewModel(repo)
        advanceUntilIdle()
        assertNull(vm.readiness.value)
        // The connection list itself still loads independently of readiness.
        assertFalse(vm.state.value is uk.co.prisom.directbanking.ui.vm.Async.Loading)
    }
}
