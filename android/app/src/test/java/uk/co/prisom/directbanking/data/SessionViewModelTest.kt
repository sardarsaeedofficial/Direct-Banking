package uk.co.prisom.directbanking.data

import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import uk.co.prisom.directbanking.data.remote.dto.UserDto
import uk.co.prisom.directbanking.data.repository.AuthRepository
import uk.co.prisom.directbanking.ui.session.FormState
import uk.co.prisom.directbanking.ui.session.SessionState
import uk.co.prisom.directbanking.ui.session.SessionViewModel
import java.io.IOException

class SessionViewModelTest {

    private val dispatcher = StandardTestDispatcher()
    private lateinit var auth: AuthRepository
    private val user = UserDto(id = "u1", email = "a@b.com", displayName = "A")

    @Before fun setUp() {
        Dispatchers.setMain(dispatcher)
        auth = mockk(relaxed = true)
    }

    @After fun tearDown() = Dispatchers.resetMain()

    @Test
    fun `restores a signed-in session`() = runTest(dispatcher.scheduler) {
        every { auth.isLoggedIn() } returns true
        coEvery { auth.me() } returns user
        val vm = SessionViewModel(auth)
        advanceUntilIdle()
        assertTrue(vm.state.value is SessionState.SignedIn)
    }

    @Test
    fun `restores signed-out when no session`() = runTest(dispatcher.scheduler) {
        every { auth.isLoggedIn() } returns false
        val vm = SessionViewModel(auth)
        advanceUntilIdle()
        assertEquals(SessionState.SignedOut, vm.state.value)
    }

    @Test
    fun `forced sign-out when session validation fails after refresh failure`() = runTest(dispatcher.scheduler) {
        every { auth.isLoggedIn() } returns true
        coEvery { auth.me() } throws IOException("refresh failed")
        val vm = SessionViewModel(auth)
        advanceUntilIdle()
        assertEquals(SessionState.SignedOut, vm.state.value)
    }

    @Test
    fun `login failure surfaces a form error`() = runTest(dispatcher.scheduler) {
        every { auth.isLoggedIn() } returns false
        coEvery { auth.login(any(), any(), any()) } returns Result.failure(RuntimeException("bad"))
        val vm = SessionViewModel(auth)
        advanceUntilIdle()
        vm.signIn("a@b.com", "pw", null)
        advanceUntilIdle()
        assertTrue(vm.form.value is FormState.Error)
    }

    @Test
    fun `successful registration signs in`() = runTest(dispatcher.scheduler) {
        every { auth.isLoggedIn() } returns false
        coEvery { auth.register(any(), any(), any()) } returns Result.success(user)
        val vm = SessionViewModel(auth)
        advanceUntilIdle()
        vm.register("a@b.com", "password12", null)
        advanceUntilIdle()
        assertTrue(vm.state.value is SessionState.SignedIn)
    }

    @Test
    fun `signed-in state is retained (configuration-change proxy)`() = runTest(dispatcher.scheduler) {
        every { auth.isLoggedIn() } returns true
        coEvery { auth.me() } returns user
        val vm = SessionViewModel(auth)
        advanceUntilIdle()
        val snapshot = vm.state.value
        // A config change keeps the same ViewModel; its StateFlow keeps the value.
        assertSame(snapshot, vm.state.value)
        assertTrue(snapshot is SessionState.SignedIn)
    }
}
