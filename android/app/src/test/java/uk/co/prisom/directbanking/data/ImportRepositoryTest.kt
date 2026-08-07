package uk.co.prisom.directbanking.data

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import uk.co.prisom.directbanking.data.local.db.ApprovedSourceEntity
import uk.co.prisom.directbanking.data.local.db.CapturedDao
import uk.co.prisom.directbanking.data.local.db.CapturedNotificationEntity
import uk.co.prisom.directbanking.data.local.db.ImportDao
import uk.co.prisom.directbanking.data.local.db.ParsedImportEntity
import uk.co.prisom.directbanking.data.local.db.PendingSyncOpEntity
import uk.co.prisom.directbanking.data.local.db.SourceDao
import uk.co.prisom.directbanking.data.local.db.SourceWithCount
import uk.co.prisom.directbanking.data.local.db.SyncDao
import uk.co.prisom.directbanking.data.remote.ApiFactory
import uk.co.prisom.directbanking.data.remote.dto.NotifAutoImportRequest
import uk.co.prisom.directbanking.data.repository.AutoImportResult
import uk.co.prisom.directbanking.data.repository.ImportOutcome
import uk.co.prisom.directbanking.data.repository.ImportRepository
import uk.co.prisom.directbanking.notifications.RawNotification

private class FakeSourceDao : SourceDao {
    val rows = mutableMapOf<String, ApprovedSourceEntity>()
    override suspend fun upsert(source: ApprovedSourceEntity) { rows[source.packageName] = source }
    override fun observeAll(): Flow<List<ApprovedSourceEntity>> = flowOf(rows.values.toList())
    override fun observeWithCounts(): Flow<List<SourceWithCount>> = flowOf(emptyList())
    override suspend fun get(pkg: String) = rows[pkg]
    override suspend fun isApproved(pkg: String) = rows[pkg]?.approved
    override suspend fun setApproved(pkg: String, approved: Boolean) { rows[pkg]?.let { rows[pkg] = it.copy(approved = approved) } }
    override suspend fun setIgnored(pkg: String, ignored: Boolean) { rows[pkg]?.let { rows[pkg] = it.copy(ignored = ignored, approved = false, autoImportEnabled = false) } }
    override suspend fun setAutoImport(pkg: String, enabled: Boolean) { rows[pkg]?.let { rows[pkg] = it.copy(autoImportEnabled = enabled) } }
    override suspend fun setRequireReview(pkg: String, required: Boolean) { rows[pkg]?.let { rows[pkg] = it.copy(requireReview = required) } }
    override suspend fun setLinkedAccount(pkg: String, accountId: String?) { rows[pkg]?.let { rows[pkg] = it.copy(defaultAccountId = accountId) } }
    override suspend fun touch(pkg: String, now: Long) { rows[pkg]?.let { rows[pkg] = it.copy(lastSeenMillis = now) } }
    override suspend fun approvedWithoutAccount() = rows.values.filter { it.approved && it.defaultAccountId == null && !it.ignored }
    override suspend fun clear() = rows.clear()
}

private class FakeImportDao : ImportDao {
    val rows = mutableMapOf<String, ParsedImportEntity>()
    override suspend fun upsert(item: ParsedImportEntity) { rows[item.fingerprint] = item }
    override suspend fun byFingerprint(fingerprint: String) = rows[fingerprint]
    override fun observeAll(): Flow<List<ParsedImportEntity>> = flowOf(rows.values.toList())
    override fun observeReviewQueue(): Flow<List<ParsedImportEntity>> = flowOf(rows.values.toList())
    override suspend fun setStatus(fingerprint: String, status: String, remoteId: String?) { rows[fingerprint]?.let { rows[fingerprint] = it.copy(localStatus = status, remoteId = remoteId) } }
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

private class FakeCapturedDao : CapturedDao {
    val rows = mutableListOf<CapturedNotificationEntity>()
    override suspend fun insert(item: CapturedNotificationEntity): Long { rows.add(item); return rows.size.toLong() }
    override suspend fun unprocessed() = rows.toList()
    override suspend fun delete(id: Long) {}
    override suspend fun latestForSource(pkg: String) = rows.filter { it.sourcePackage == pkg }.maxByOrNull { it.capturedAtMillis }
    override suspend fun deleteForSource(pkg: String) { rows.removeAll { it.sourcePackage == pkg } }
    override suspend fun clear() = rows.clear()
}

class ImportRepositoryTest {

    private fun raw(pkg: String, text: String, time: Long = 1_000L, title: String = "Bank") =
        RawNotification(pkg, time, null, null, title, text, null, emptyList(), null)

    private fun store(vararg seeded: ApprovedSourceEntity): Triple<FakeSourceDao, FakeImportDao, FakeSyncDao> {
        val s = FakeSourceDao(); seeded.forEach { s.rows[it.packageName] = it }
        return Triple(s, FakeImportDao(), FakeSyncDao())
    }

    private fun src(pkg: String, name: String, approved: Boolean = true, auto: Boolean = true, account: String? = "acc1", trusted: Boolean = false, requireReview: Boolean = false, ignored: Boolean = false) =
        ApprovedSourceEntity(pkg, name, approved = approved, ignored = ignored, autoImportEnabled = auto, requireReview = requireReview, defaultAccountId = account, isBuiltInTrusted = trusted, firstObservedMillis = 0, lastSeenMillis = 0)

    private fun repo(
        source: FakeSourceDao, import: FakeImportDao, sync: FakeSyncDao, captured: FakeCapturedDao = FakeCapturedDao(),
        auto: suspend (NotifAutoImportRequest) -> AutoImportResult = { AutoImportResult.Imported("txn-1", "rem-1") },
    ) = ImportRepository(import, sync, source, captured, FakeTokenStore(), uk.co.prisom.directbanking.parsing.ParserRegistry(), ApiFactory.json, autoImport = auto, clock = { 5_000L })

    @Test fun `built-in Monzo source is automatically trusted`() = runTest {
        val (s, i, y) = store()
        repo(s, i, y).capture(raw("co.uk.getmondo", "You spent £5 at Tesco"), "Monzo")
        val row = s.rows["co.uk.getmondo"]!!
        assertTrue(row.approved); assertTrue(row.autoImportEnabled); assertTrue(row.isBuiltInTrusted)
        assertEquals("Monzo", row.label)
    }

    @Test fun `built-in Revolut source is automatically trusted`() = runTest {
        val (s, i, y) = store()
        repo(s, i, y).capture(raw("com.revolut.revolut", "You sent £5 to Jane"), "Revolut")
        val row = s.rows["com.revolut.revolut"]!!
        assertTrue(row.approved); assertTrue(row.autoImportEnabled); assertTrue(row.isBuiltInTrusted)
    }

    @Test fun `all configured built-in banks default to auto-import`() = runTest {
        for (t in TrustedSources.all) {
            val (s, i, y) = store()
            repo(s, i, y).capture(raw(t.packageName, "You spent £5 at Shop"), t.displayName)
            val row = s.rows[t.packageName]!!
            assertTrue("${t.displayName} approved", row.approved)
            assertTrue("${t.displayName} auto", row.autoImportEnabled)
        }
    }

    @Test fun `unknown source requires one-time approval`() = runTest {
        val (s, i, y) = store(); val cap = FakeCapturedDao()
        val out = repo(s, i, y, cap).capture(raw("com.example.unknownbank", "You spent £5 at Tesco"), "Unknown")
        assertEquals(ImportOutcome.SETUP_REQUIRED, out.outcome)
        assertEquals(false, s.rows["com.example.unknownbank"]!!.approved)
        assertNotNull("remembered for reprocessing", cap.latestForSource("com.example.unknownbank"))
        assertTrue(i.rows.isEmpty())
    }

    @Test fun `approving an unknown source reprocesses its latest notification and auto-imports`() = runTest {
        val (s, i, y) = store(); val cap = FakeCapturedDao()
        val r = repo(s, i, y, cap)
        r.capture(raw("com.example.unknownbank", "You spent £12.45 at Tesco"), "Unknown") // SETUP_REQUIRED, remembered
        // User approves + maps an account.
        s.rows["com.example.unknownbank"] = s.rows["com.example.unknownbank"]!!.copy(approved = true, autoImportEnabled = true, defaultAccountId = "acc1")
        val out = r.reprocessLatest("com.example.unknownbank", "Unknown")!!
        assertEquals(ImportOutcome.AUTO_IMPORTED, out.outcome)
        assertEquals("txn-1", out.transactionId)
    }

    @Test fun `later notifications from an approved source auto-import`() = runTest {
        val (s, i, y) = store(src("co.uk.getmondo", "Monzo", trusted = true))
        val out = repo(s, i, y).capture(raw("co.uk.getmondo", "You spent £12.45 at Tesco"), "Monzo")
        assertEquals(ImportOutcome.AUTO_IMPORTED, out.outcome)
        assertEquals("EXPENSE", out.direction)
        assertEquals(1245L, out.amountMinor)
    }

    @Test fun `Monzo 2 pound credit auto-imports as a CREDIT`() = runTest {
        val (s, i, y) = store(src("co.uk.getmondo", "Monzo", trusted = true))
        val out = repo(s, i, y).capture(raw("co.uk.getmondo", "💸 £2 from Sardar Saeed: Sent from Revolut", title = "Monzo"), "Monzo")
        assertEquals(ImportOutcome.AUTO_IMPORTED, out.outcome)
        assertEquals("INCOME", out.direction)
        assertEquals(200L, out.amountMinor)
    }

    @Test fun `unmapped source produces SETUP_REQUIRED`() = runTest {
        val (s, i, y) = store(src("co.uk.getmondo", "Monzo", account = null, trusted = true))
        val out = repo(s, i, y).capture(raw("co.uk.getmondo", "You spent £5 at Tesco"), "Monzo")
        assertEquals(ImportOutcome.SETUP_REQUIRED, out.outcome)
    }

    @Test fun `ambiguous parsing (undetermined direction) goes to Review`() = runTest {
        val (s, i, y) = store(src("com.example.bank", "Bank"))
        // Amount present but no direction verb → no clear candidate → Review, never auto.
        val out = repo(s, i, y).capture(raw("com.example.bank", "£10.00 processed today"), "Bank")
        assertEquals(ImportOutcome.REVIEW_REQUIRED, out.outcome)
    }

    @Test fun `auto-import disabled keeps a source in Review`() = runTest {
        val (s, i, y) = store(src("com.example.bank", "Bank", auto = false))
        val out = repo(s, i, y).capture(raw("com.example.bank", "You spent £5 at Shop"), "Bank")
        assertEquals(ImportOutcome.REVIEW_REQUIRED, out.outcome)
    }

    @Test fun `declined notifications are not imported`() = runTest {
        val (s, i, y) = store(src("co.uk.getmondo", "Monzo", trusted = true))
        val out = repo(s, i, y).capture(raw("co.uk.getmondo", "Your £20 payment to Tesco was declined"), "Monzo")
        assertEquals(ImportOutcome.REJECTED, out.outcome)
        assertTrue(i.rows.isEmpty())
    }

    @Test fun `promotional notifications are not imported`() = runTest {
        val (s, i, y) = store(src("co.uk.getmondo", "Monzo", trusted = true))
        val out = repo(s, i, y).capture(raw("co.uk.getmondo", "Special offer: get £5 off your next purchase"), "Monzo")
        assertEquals(ImportOutcome.REJECTED, out.outcome)
    }

    @Test fun `per-source require review overrides automatic import`() = runTest {
        val (s, i, y) = store(src("co.uk.getmondo", "Monzo", trusted = true, requireReview = true))
        val out = repo(s, i, y).capture(raw("co.uk.getmondo", "You spent £12.45 at Tesco"), "Monzo")
        assertEquals(ImportOutcome.REVIEW_REQUIRED, out.outcome)
    }

    @Test fun `ignored sources remain blocked`() = runTest {
        val (s, i, y) = store(src("co.uk.getmondo", "Monzo", approved = false, auto = false, ignored = true, trusted = true))
        val out = repo(s, i, y).capture(raw("co.uk.getmondo", "You spent £5 at Tesco"), "Monzo")
        assertEquals(ImportOutcome.REJECTED, out.outcome)
        assertTrue(i.rows.isEmpty())
    }

    @Test fun `duplicate notification is reported once`() = runTest {
        val (s, i, y) = store(src("co.uk.getmondo", "Monzo", trusted = true))
        val r = repo(s, i, y)
        assertEquals(ImportOutcome.AUTO_IMPORTED, r.capture(raw("co.uk.getmondo", "You spent £12.45 at Tesco"), "Monzo").outcome)
        assertEquals(ImportOutcome.DUPLICATE, r.capture(raw("co.uk.getmondo", "You spent £12.45 at Tesco"), "Monzo").outcome)
    }

    @Test fun `auto-import failure queues a retry op`() = runTest {
        val (s, i, y) = store(src("co.uk.getmondo", "Monzo", trusted = true))
        val out = repo(s, i, y, auto = { AutoImportResult.Failed }).capture(raw("co.uk.getmondo", "You spent £12.45 at Tesco"), "Monzo")
        assertEquals(ImportOutcome.SYNC_FAILED, out.outcome)
        assertTrue(y.ops.any { it.type == "AUTO_IMPORT" })
    }

    @Test fun `nothing is captured before disclosure is accepted`() = runTest {
        val (s, i, y) = store(src("co.uk.getmondo", "Monzo", trusted = true))
        val out = ImportRepository(i, y, s, FakeCapturedDao(), FakeTokenStore(), uk.co.prisom.directbanking.parsing.ParserRegistry(), ApiFactory.json, disclosureAccepted = { false }, clock = { 5_000L })
            .capture(raw("co.uk.getmondo", "You spent £12.45 at Tesco"), "Monzo")
        assertEquals(ImportOutcome.REJECTED, out.outcome)
        assertTrue(i.rows.isEmpty())
    }
}
