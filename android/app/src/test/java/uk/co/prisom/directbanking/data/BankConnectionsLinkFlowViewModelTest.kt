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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import uk.co.prisom.directbanking.data.remote.dto.BankConnectionDetailResponse
import uk.co.prisom.directbanking.data.remote.dto.BankConnectionDto
import uk.co.prisom.directbanking.data.remote.dto.StartConnectionResponse
import uk.co.prisom.directbanking.data.repository.BankConnectionRepository
import uk.co.prisom.directbanking.ui.vm.BankConnectionDetailViewModel
import uk.co.prisom.directbanking.ui.vm.BankConnectionsViewModel
import uk.co.prisom.directbanking.ui.vm.ConnectAction

// Final release completion (§2): the Plaid Link SDK itself succeeding only means
// the user completed authorization with their bank — the server-side public-token
// exchange can still fail. Before this round, completePlaid() had no failure path
// at all: a failed exchange left the screen showing nothing, so the user had no
// way to tell whether their bank actually connected. These tests pin both outcomes.
class BankConnectionsLinkFlowViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private lateinit var repo: BankConnectionRepository

    @Before fun setUp() {
        Dispatchers.setMain(dispatcher)
        // relaxed = true supplies a default (non-null) BankConnectionsReadiness for
        // the unstubbed readiness() call — these tests don't exercise readiness.
        repo = mockk(relaxed = true)
        coEvery { repo.list() } returns emptyList()
    }

    @After fun tearDown() = Dispatchers.resetMain()

    @Test
    fun `connectAnother with a link_token response emits LaunchPlaid`() = runTest(dispatcher.scheduler) {
        coEvery { repo.start() } returns StartConnectionResponse("conn-1", "plaid", "link_token", null, "link-sandbox-abc")
        val vm = BankConnectionsViewModel(repo)
        advanceUntilIdle()
        vm.connectAnother()
        advanceUntilIdle()
        val action = vm.action.value
        assertTrue(action is ConnectAction.LaunchPlaid)
        assertEquals("conn-1", (action as ConnectAction.LaunchPlaid).connectionId)
        assertEquals("link-sandbox-abc", action.linkToken)
    }

    @Test
    fun `connectAnother with a hosted_url response emits OpenBrowser, never LaunchPlaid`() = runTest(dispatcher.scheduler) {
        coEvery { repo.start() } returns StartConnectionResponse("conn-2", "truelayer", "hosted_url", "https://auth.truelayer.com/x", null)
        val vm = BankConnectionsViewModel(repo)
        advanceUntilIdle()
        vm.connectAnother()
        advanceUntilIdle()
        assertTrue(vm.action.value is ConnectAction.OpenBrowser)
    }

    @Test
    fun `Plaid Link success followed by a successful server exchange clears any message and refreshes`() = runTest(dispatcher.scheduler) {
        coEvery { repo.complete("conn-1", "public-good") } returns true
        val vm = BankConnectionsViewModel(repo)
        advanceUntilIdle()
        vm.completePlaid("conn-1", "public-good")
        advanceUntilIdle()
        assertNull(vm.message.value)
    }

    @Test
    fun `Plaid Link success but a failed server exchange surfaces a clear message, never silence`() = runTest(dispatcher.scheduler) {
        coEvery { repo.complete("conn-1", "public-bad") } returns false
        val vm = BankConnectionsViewModel(repo)
        advanceUntilIdle()
        vm.completePlaid("conn-1", "public-bad")
        advanceUntilIdle()
        assertNotNull(vm.message.value)
    }

    @Test
    fun `Plaid Link success but a network error during exchange also surfaces a message, not a silent crash`() = runTest(dispatcher.scheduler) {
        coEvery { repo.complete("conn-1", "public-net-fail") } throws RuntimeException("network error")
        val vm = BankConnectionsViewModel(repo)
        advanceUntilIdle()
        vm.completePlaid("conn-1", "public-net-fail")
        advanceUntilIdle()
        assertNotNull(vm.message.value)
    }

    @Test
    fun `the user exiting Plaid Link without finishing never surfaces an error message`() = runTest(dispatcher.scheduler) {
        val vm = BankConnectionsViewModel(repo)
        advanceUntilIdle()
        vm.onLinkCancelled()
        advanceUntilIdle()
        assertNull(vm.message.value)
    }

    @Test
    fun `consumedMessage clears a shown message so it is not re-shown on recomposition`() = runTest(dispatcher.scheduler) {
        coEvery { repo.complete("conn-1", "public-bad") } returns false
        val vm = BankConnectionsViewModel(repo)
        advanceUntilIdle()
        vm.completePlaid("conn-1", "public-bad")
        advanceUntilIdle()
        assertNotNull(vm.message.value)
        vm.consumedMessage()
        assertNull(vm.message.value)
    }

    @Test
    fun `detail screen reconnect exchange failure surfaces a message without crashing`() = runTest(dispatcher.scheduler) {
        val conn = BankConnectionDto(id = "conn-3", provider = "plaid", status = "REAUTH_REQUIRED")
        coEvery { repo.detail("conn-3") } returns BankConnectionDetailResponse(conn, emptyList())
        coEvery { repo.complete("conn-3", "public-bad") } returns false
        val vm = BankConnectionDetailViewModel(repo, "conn-3")
        advanceUntilIdle()
        vm.completePlaid("public-bad")
        advanceUntilIdle()
        assertNotNull(vm.message.value)
    }

    @Test
    fun `detail screen reconnect exchange success surfaces a positive confirmation`() = runTest(dispatcher.scheduler) {
        val conn = BankConnectionDto(id = "conn-4", provider = "plaid", status = "REAUTH_REQUIRED")
        coEvery { repo.detail("conn-4") } returns BankConnectionDetailResponse(conn, emptyList())
        coEvery { repo.complete("conn-4", "public-good") } returns true
        val vm = BankConnectionDetailViewModel(repo, "conn-4")
        advanceUntilIdle()
        vm.completePlaid("public-good")
        advanceUntilIdle()
        assertEquals("Reconnected", vm.message.value)
    }
}
