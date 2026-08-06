package uk.co.prisom.directbanking.data

import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import org.junit.Assert.assertEquals
import org.junit.Test
import retrofit2.HttpException
import uk.co.prisom.directbanking.data.local.db.ImportDao
import uk.co.prisom.directbanking.data.local.db.ParsedImportEntity
import uk.co.prisom.directbanking.data.local.db.PendingSyncOpEntity
import uk.co.prisom.directbanking.data.local.db.SyncDao
import uk.co.prisom.directbanking.data.remote.ApiFactory
import uk.co.prisom.directbanking.data.remote.MobileApi
import uk.co.prisom.directbanking.data.remote.dto.NotifImportCreateResponse
import uk.co.prisom.directbanking.data.remote.dto.NotifImportDto
import uk.co.prisom.directbanking.data.remote.dto.NotifImportPatchRequest
import uk.co.prisom.directbanking.data.remote.dto.NotifImportRequest
import uk.co.prisom.directbanking.data.repository.SyncRepository
import java.io.IOException

class SyncRepositoryTest {

    private val json = ApiFactory.json

    private fun createOp() = PendingSyncOpEntity(
        id = 1, type = "CREATE_IMPORT", fingerprint = "fp1",
        payloadJson = json.encodeToString(
            NotifImportRequest("fp1", "com.bank", "EXPENSE", 1245, "GBP", "Tesco", null, "2026-01-01T00:00:00Z", 0.95),
        ),
        createdAtMillis = 0,
    )

    @Test
    fun `successful create marks synced and removes op`() = runTest {
        val op = createOp()
        val syncDao = mockk<SyncDao>(relaxed = true); coEvery { syncDao.all() } returns listOf(op)
        val importDao = mockk<ImportDao>(relaxed = true)
        val api = mockk<MobileApi>()
        coEvery { api.createImport(any()) } returns NotifImportCreateResponse(NotifImportDto(id = "remote-1"), duplicate = false)

        val outcome = SyncRepository(api, importDao, syncDao, json).processPending()

        assertEquals(SyncRepository.Outcome.DONE, outcome)
        coVerify { importDao.setStatus("fp1", "SYNCED", "remote-1") }
        coVerify { syncDao.delete(op) }
    }

    @Test
    fun `offline create retries and keeps the op queued`() = runTest {
        val op = createOp()
        val syncDao = mockk<SyncDao>(relaxed = true); coEvery { syncDao.all() } returns listOf(op)
        val importDao = mockk<ImportDao>(relaxed = true)
        val api = mockk<MobileApi>()
        coEvery { api.createImport(any()) } throws IOException("offline")

        val outcome = SyncRepository(api, importDao, syncDao, json).processPending()

        assertEquals(SyncRepository.Outcome.RETRY, outcome)
        coVerify { syncDao.markFailure(1, any()) }
        coVerify(exactly = 0) { syncDao.delete(op) }
    }

    @Test
    fun `approve conflict is treated as idempotent success`() = runTest {
        val op = PendingSyncOpEntity(
            id = 2, type = "APPROVE", fingerprint = "fp1",
            payloadJson = json.encodeToString(NotifImportPatchRequest(action = "approve", accountId = "acc1")),
            createdAtMillis = 0,
        )
        val syncDao = mockk<SyncDao>(relaxed = true); coEvery { syncDao.all() } returns listOf(op)
        val importDao = mockk<ImportDao>(relaxed = true)
        coEvery { importDao.byFingerprint("fp1") } returns parsed(remoteId = "remote-1")
        val api = mockk<MobileApi>()
        val http409 = mockk<HttpException>(relaxed = true); every { http409.code() } returns 409
        coEvery { api.patchImport(any(), any()) } throws http409

        val outcome = SyncRepository(api, importDao, syncDao, json).processPending()

        assertEquals(SyncRepository.Outcome.DONE, outcome)
        coVerify { syncDao.delete(op) }
    }

    @Test
    fun `empty queue is idle`() = runTest {
        val syncDao = mockk<SyncDao>(relaxed = true); coEvery { syncDao.all() } returns emptyList()
        val outcome = SyncRepository(mockk(), mockk(relaxed = true), syncDao, json).processPending()
        assertEquals(SyncRepository.Outcome.IDLE, outcome)
    }

    private fun parsed(remoteId: String?) = ParsedImportEntity(
        fingerprint = "fp1", sourcePackage = "com.bank", direction = "EXPENSE", amountMinor = 1245,
        currency = "GBP", merchant = "Tesco", accountHint = null, occurredAtMillis = 0, confidence = 0.95,
        reviewState = "DRAFT", redactedText = "", title = "Tesco", localStatus = "SYNCED", remoteId = remoteId, createdAtMillis = 0,
    )
}
