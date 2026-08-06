package uk.co.prisom.directbanking.data

import android.app.Application
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import uk.co.prisom.directbanking.data.local.AppPreferences
import uk.co.prisom.directbanking.notifications.NotificationAccess

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class AppPreferencesTest {
    @Test
    fun `disclosure acceptance is persisted and can be declined`() = runBlocking {
        val prefs = AppPreferences(RuntimeEnvironment.getApplication())
        assertFalse(prefs.disclosureAccepted.first())
        prefs.setDisclosureAccepted(true)
        assertTrue(prefs.disclosureAccepted.first())
        prefs.setDisclosureAccepted(false)
        assertFalse(prefs.disclosureAccepted.first())
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class NotificationAccessTest {
    @Test
    fun `access is not granted by default`() {
        assertFalse(NotificationAccess.isEnabled(RuntimeEnvironment.getApplication()))
    }
}
