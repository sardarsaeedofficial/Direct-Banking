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
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response
import uk.co.prisom.directbanking.data.local.db.DirectBankingDatabase
import uk.co.prisom.directbanking.data.repository.AuthRepository
import uk.co.prisom.directbanking.ui.vm.SettingsViewModel

// Final release completion (§3): account deletion must clear local Room data
// on success (so no previous account data remains visible offline), must
// never wipe local data on failure (the account still exists — wiping the
// cache would just look like data loss to the user), and must surface a
// clear, non-leaking reason when it fails.
class SettingsViewModelDeleteAccountTest {
    private val dispatcher = StandardTestDispatcher()
    private lateinit var auth: AuthRepository
    private lateinit var db: DirectBankingDatabase

    @Before fun setUp() {
        Dispatchers.setMain(dispatcher)
        auth = mockk(relaxed = true)
        db = mockk(relaxed = true)
    }

    @After fun tearDown() = Dispatchers.resetMain()

    @Test
    fun `successful deletion clears every Room table and calls onDeleted`() = runTest(dispatcher.scheduler) {
        coEvery { auth.deleteAccount("correct-password") } returns Result.success(Unit)
        val vm = SettingsViewModel(auth, db)
        var deleted = false
        // deleteAccount() hops onto the real Dispatchers.IO for db.clearAllTables()
        // (exactly like production — only the mock's execution is instant), which
        // advanceUntilIdle() alone doesn't reliably wait out since that work isn't
        // on the virtual-time test dispatcher. Joining the returned Job does.
        val job = vm.deleteAccount("correct-password") { deleted = true }
        job.join()
        advanceUntilIdle()
        assertTrue(deleted)
        coVerify(exactly = 1) { db.clearAllTables() }
        assertNull(vm.deleteAccountError.value)
        assertEquals(false, vm.busy.value)
    }

    @Test
    fun `an incorrect password never clears local data and reports a clear reason`() = runTest(dispatcher.scheduler) {
        val response: Response<Unit> = Response.error(401, "".toResponseBody("application/json".toMediaType()))
        coEvery { auth.deleteAccount("wrong-password") } returns Result.failure(HttpException(response))
        val vm = SettingsViewModel(auth, db)
        var deleted = false
        vm.deleteAccount("wrong-password") { deleted = true }
        advanceUntilIdle()
        assertTrue(!deleted)
        coVerify(exactly = 0) { db.clearAllTables() }
        assertEquals("Incorrect password", vm.deleteAccountError.value)
    }

    @Test
    fun `a network failure never clears local data and never crashes`() = runTest(dispatcher.scheduler) {
        coEvery { auth.deleteAccount("any-password") } returns Result.failure(java.io.IOException("network error"))
        val vm = SettingsViewModel(auth, db)
        var deleted = false
        vm.deleteAccount("any-password") { deleted = true }
        advanceUntilIdle()
        assertTrue(!deleted)
        coVerify(exactly = 0) { db.clearAllTables() }
        assertEquals("Couldn't delete your account — please try again.", vm.deleteAccountError.value)
    }

    @Test
    fun `consumedDeleteAccountError clears a shown error`() = runTest(dispatcher.scheduler) {
        coEvery { auth.deleteAccount("wrong") } returns Result.failure(RuntimeException("nope"))
        val vm = SettingsViewModel(auth, db)
        vm.deleteAccount("wrong") { }
        advanceUntilIdle()
        assertTrue(vm.deleteAccountError.value != null)
        vm.consumedDeleteAccountError()
        assertNull(vm.deleteAccountError.value)
    }
}
