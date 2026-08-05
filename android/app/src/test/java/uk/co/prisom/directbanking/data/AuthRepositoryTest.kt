package uk.co.prisom.directbanking.data

import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import uk.co.prisom.directbanking.data.remote.ApiClients
import uk.co.prisom.directbanking.data.remote.MobileApi
import uk.co.prisom.directbanking.data.remote.dto.TokenResponse
import uk.co.prisom.directbanking.data.repository.AuthRepository
import java.io.IOException

class AuthRepositoryTest {

    private fun repo(publicApi: MobileApi, store: FakeTokenStore): AuthRepository {
        val authApi = mockk<MobileApi>(relaxed = true)
        return AuthRepository(ApiClients(authApi = authApi, publicApi = publicApi), store, "1.0-test")
    }

    @Test
    fun `refresh rotates and stores new tokens`() = runTest {
        val store = FakeTokenStore().apply { seed(access = "old-access", refresh = "refresh-1") }
        val publicApi = mockk<MobileApi>()
        coEvery { publicApi.refresh(any()) } returns TokenResponse("new-access", "refresh-2", 900)

        assertTrue(repo(publicApi, store).refresh())
        assertEquals("new-access", store.accessToken())
        assertEquals("refresh-2", store.refreshToken())
    }

    @Test
    fun `failed refresh clears the session`() = runTest {
        val store = FakeTokenStore().apply { seed(access = "old-access", refresh = "refresh-1") }
        val publicApi = mockk<MobileApi>()
        coEvery { publicApi.refresh(any()) } throws IOException("invalid refresh")

        assertFalse(repo(publicApi, store).refresh())
        assertTrue(store.cleared)
        assertFalse(store.isLoggedIn())
    }

    @Test
    fun `refresh without a token is a no-op failure`() = runTest {
        val store = FakeTokenStore() // no tokens
        val publicApi = mockk<MobileApi>(relaxed = true)
        assertFalse(repo(publicApi, store).refresh())
    }
}
