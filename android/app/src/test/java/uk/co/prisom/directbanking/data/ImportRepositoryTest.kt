package uk.co.prisom.directbanking.data

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import uk.co.prisom.directbanking.data.local.db.ApprovedSourceEntity
import uk.co.prisom.directbanking.data.local.db.CapturedNotificationEntity
import uk.co.prisom.directbanking.data.local.db.ImportDao
import uk.co.prisom.directbanking.data.local.db.ParsedImportEntity
import uk.co.prisom.directbanking.data.local.db.PendingSyncOpEntity
import uk.co.prisom.directbanking.data.local.db.SourceDao
import uk.co.prisom.directbanking.data.local.db.SourceWithCount
import uk.co.prisom.directbanking.data.local.db.SyncDao
import uk.co.prisom.directbanking.data.remote.ApiFactory
import uk.co.prisom.directbanking.data.repository.CaptureResult
import uk.co.prisom.directbanking.data.repository.ImportRepository
import uk.co.prisom.directbanking.notifications.RawNotification
import uk.co.prisom.directbanking.parsing.ParserRegistry

private class FakeSourceDao : SourceDao {
    val rows = mutableMapOf<String, ApprovedSourceEntity>()
    override suspend fun upsert(source: ApprovedSourceEntity) { rows[source.packageName] = source }
    override fun observeAll(): Flow<List<ApprovedSourceEntity>> = flowOf(rows.values.toList())
    override fun observeWithCounts(): Flow<List<SourceWithCount>> = flowOf(emptyList())
    override suspend fun get(pkg: String) = rows[pkg]
    override suspend fun isApproved(pkg: String) = rows[pkg]?.approved
    override suspend fun setApproved(pkg: String, approved: Boolean) { rows[pkg]?.let { rows[pkg] = it.copy(approved = approved) } }
    override suspend fun setIgnored(pkg: String, ignored: Boolean) { rows[pkg]?.let { rows[pkg] = it.copy(ignored = ignored, approved = false) } }
    override suspend fun touch(pkg: String, now: Long) { rows[pkg]?.let { rows[pkg] = it.copy(lastSeenMillis = now) } }
    override suspend fun clear() = rows.clear()
}

private class FakeImportDao : ImportDao {
    val rows = mutableMapOf<String, ParsedImportEntity>()
    override suspend fun upsert(item: ParsedImportEntity) { rows[item.fingerprint] = item }
    override suspend fun byFingerprint(fingerprint: String) = rows[fingerprint]
    override fun observeAll(): Flow<List<ParsedImportEntity>> = flowOf(rows.values.toList())
    override fun observeReviewQueue(): Flow<List<ParsedImportEntity>> = flowOf(rows.values.toList())
    override suspend fun setStatus(fingerprint: String, status: String, remoteId: String?) {
        rows[fingerprint]?.let { rows[fingerprint] = it.copy(localStatus = status, remoteId = remoteId) }
    }
    override suspend fun delete(fingerprint: String) { rows.remove(fingerprint) }
}

private class FakeSyncDao : SyncDao {
    val ops = mutableListOf<PendingSyncOpEntity>()
    private var nextId = 1L
    override suspend fun insert(op: PendingSyncOpEntity): Long { val id = nextId++; ops.add(op.copy(id = id)); return id }
    override suspend fun all() = ops.toList()
    override fun observeCount(): Flow<Int> = flowOf(ops.size)
    override suspend fun delete(op: PendingSyncOpEntity) { ops.removeAll { it.id == op.id } }
    override suspend fun markFailure(id: Long, error: String?) {}
    override suspend fun deletePendingCreate(fingerprint: String) { ops.removeAll { it.type == "CREATE_IMPORT" && it.fingerprint == fingerprint } }
}

@Suppress("unused")
private fun captured() = CapturedNotificationEntity(sourcePackage = "x", postTime = 0, title = null, redactedText = "", capturedAtMillis = 0)

class ImportRepositoryTest {

    private val pkg = "com.example.simbank"
    private val cardRaw = RawNotification(pkg, 1_000L, null, null, "Bank", "You spent £12.45 at Tesco", null, emptyList(), null)

    private fun repo(source: FakeSourceDao, import: FakeImportDao, sync: FakeSyncDao) =
        ImportRepository(import, sync, source, FakeTokenStore(), ParserRegistry(), ApiFactory.json) { 5_000L }

    @Test
    fun `unapproved source is not parsed or stored, only observed`() = runTest {
        val source = FakeSourceDao(); val import = FakeImportDao(); val sync = FakeSyncDao()
        val result = repo(source, import, sync).capture(cardRaw, "Bank")
        assertTrue(result is CaptureResult.SourceNotApproved)
        assertTrue("no parsed import stored", import.rows.isEmpty())
        assertTrue("no upload queued", sync.ops.isEmpty())
        // Observed as metadata only (label + package), never notification text.
        assertEquals("Bank", source.rows[pkg]?.label)
    }

    @Test
    fun `approved source persists a draft and queues an idempotent upload`() = runTest {
        val source = FakeSourceDao().apply { rows[pkg] = ApprovedSourceEntity(pkg, "Bank", approved = true, firstObservedMillis = 0, lastSeenMillis = 0) }
        val import = FakeImportDao(); val sync = FakeSyncDao()
        val result = repo(source, import, sync).capture(cardRaw, "Bank")
        assertTrue(result is CaptureResult.Stored)
        assertEquals(1, import.rows.size)
        assertTrue(sync.ops.any { it.type == "CREATE_IMPORT" })
    }

    @Test
    fun `approve marks the import approved and queues an approve upload`() = runTest {
        val source = FakeSourceDao().apply { rows[pkg] = ApprovedSourceEntity(pkg, "Bank", approved = true, firstObservedMillis = 0, lastSeenMillis = 0) }
        val import = FakeImportDao(); val sync = FakeSyncDao()
        val r = repo(source, import, sync)
        r.capture(cardRaw, "Bank")
        val fingerprint = import.rows.keys.first()
        r.approve(fingerprint, accountId = "acc1", categoryId = null, amountMinor = 1245, direction = "EXPENSE", merchant = "Tesco", occurredAtMillis = 1000L, notes = null)
        assertEquals("APPROVED", import.rows[fingerprint]?.localStatus)
        assertTrue(sync.ops.any { it.type == "APPROVE" })
    }

    @Test
    fun `permanently ignored source is dropped`() = runTest {
        val source = FakeSourceDao().apply { rows[pkg] = ApprovedSourceEntity(pkg, "Bank", approved = false, ignored = true, firstObservedMillis = 0, lastSeenMillis = 0) }
        val import = FakeImportDao(); val sync = FakeSyncDao()
        val result = repo(source, import, sync).capture(cardRaw, "Bank")
        assertTrue(result is CaptureResult.Ignored)
        assertTrue(import.rows.isEmpty())
    }
}
