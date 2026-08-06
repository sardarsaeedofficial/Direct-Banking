package uk.co.prisom.directbanking.data

import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import uk.co.prisom.directbanking.data.remote.MobileApi
import uk.co.prisom.directbanking.data.remote.SessionRefresher
import uk.co.prisom.directbanking.data.remote.dto.TokenResponse
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger

class SessionRefresherTest {

    @Test
    fun `concurrent refreshes coalesce into a single network call`() = runTest {
        val calls = AtomicInteger(0)
        val api = mockk<MobileApi>()
        coEvery { api.refresh(any()) } coAnswers {
            calls.incrementAndGet()
            delay(100) // keep the flight in-progress while others arrive
            TokenResponse("new-access", "new-refresh", 900)
        }
        val store = FakeTokenStore().apply { seed("old-access", "refresh-1") }
        val refresher = SessionRefresher(api, store, backgroundScope)

        val results = (1..12).map { async { refresher.refresh() } }.awaitAll()

        assertEquals(1, calls.get())
        assertTrue(results.all { it })
        assertEquals("new-access", store.accessToken())
    }

    @Test
    fun `a later refresh starts a new flight`() = runTest {
        val calls = AtomicInteger(0)
        val api = mockk<MobileApi>()
        coEvery { api.refresh(any()) } coAnswers { calls.incrementAndGet(); TokenResponse("a", "b", 900) }
        val store = FakeTokenStore().apply { seed("old", "r1") }
        val refresher = SessionRefresher(api, store, backgroundScope)

        assertTrue(refresher.refresh())
        assertTrue(refresher.refresh())
        assertEquals(2, calls.get())
    }

    @Test
    fun `failed refresh clears the session`() = runTest {
        val api = mockk<MobileApi>()
        coEvery { api.refresh(any()) } throws IOException("revoked")
        val store = FakeTokenStore().apply { seed("old", "r1") }
        val refresher = SessionRefresher(api, store, backgroundScope)

        assertFalse(refresher.refresh())
        assertTrue(store.cleared)
    }
}
