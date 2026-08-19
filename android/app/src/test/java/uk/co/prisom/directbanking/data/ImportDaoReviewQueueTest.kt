package uk.co.prisom.directbanking.data

import android.app.Application
import androidx.room.Room
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import uk.co.prisom.directbanking.data.local.db.DirectBankingDatabase
import uk.co.prisom.directbanking.data.local.db.ParsedImportEntity

/**
 * Regression test for a real bug found while adding Capital One coverage
 * (round-2 §5/§12): ImportRepository upserts ACCOUNT_MAPPING_REQUIRED rows
 * expecting them to surface in the Review Centre, but ImportDao's
 * `observeReviewQueue()` SQL originally filtered `reviewState IN
 * ('DRAFT','REVIEW_REQUIRED','UNRECOGNISED')` — a set that did not include
 * 'ACCOUNT_MAPPING_REQUIRED'. That row would be silently written to Room and
 * never shown to the user at all — no crash, no error, just permanently
 * invisible. Exercises the actual compiled Room query (not a fake DAO), so a
 * future accidental narrowing of that IN-list would fail this test.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class ImportDaoReviewQueueTest {

    private fun db(): DirectBankingDatabase =
        Room.inMemoryDatabaseBuilder(RuntimeEnvironment.getApplication(), DirectBankingDatabase::class.java)
            .allowMainThreadQueries()
            .build()

    private fun entity(fingerprint: String, reviewState: String, localStatus: String = "LOCAL") = ParsedImportEntity(
        fingerprint = fingerprint, sourcePackage = "com.ie.capitalone.uk", direction = "EXPENSE",
        amountMinor = 488, currency = "GBP", merchant = "ALIEXPRESS.COM", accountHint = "7813",
        occurredAtMillis = 1000, confidence = 0.96, reviewState = reviewState, redactedText = "£4.88 on card ending 7813",
        title = "ALIEXPRESS.COM", localStatus = localStatus, createdAtMillis = 1000,
    )

    @Test fun `ACCOUNT_MAPPING_REQUIRED rows appear in the observed review queue`() = runBlocking {
        val database = db()
        database.importDao().upsert(entity("cap1", "ACCOUNT_MAPPING_REQUIRED"))

        val queue = database.importDao().observeReviewQueue().first()
        assertEquals(1, queue.size)
        assertEquals("cap1", queue[0].fingerprint)
        assertEquals("ALIEXPRESS.COM", queue[0].merchant)
        assertEquals(488L, queue[0].amountMinor) // never 0
        database.close()
    }

    @Test fun `ordinary DRAFT and REVIEW_REQUIRED rows still appear (no regression)`() = runBlocking {
        val database = db()
        database.importDao().upsert(entity("d1", "DRAFT"))
        database.importDao().upsert(entity("r1", "REVIEW_REQUIRED"))

        val queue = database.importDao().observeReviewQueue().first()
        assertEquals(setOf("d1", "r1"), queue.map { it.fingerprint }.toSet())
        database.close()
    }

    @Test fun `an ACCOUNT_MAPPING_REQUIRED row already approved does not linger in the queue`() = runBlocking {
        val database = db()
        database.importDao().upsert(entity("cap2", "ACCOUNT_MAPPING_REQUIRED", localStatus = "APPROVED"))

        val queue = database.importDao().observeReviewQueue().first()
        assertTrue(queue.none { it.fingerprint == "cap2" })
        database.close()
    }
}
