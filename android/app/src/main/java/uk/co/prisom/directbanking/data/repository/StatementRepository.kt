package uk.co.prisom.directbanking.data.repository

import uk.co.prisom.directbanking.data.remote.ApiClients
import uk.co.prisom.directbanking.data.remote.dto.StatementCreateRequest
import uk.co.prisom.directbanking.data.remote.dto.StatementImportDto
import uk.co.prisom.directbanking.data.remote.dto.StatementImportRequest
import uk.co.prisom.directbanking.data.remote.dto.StatementImportResultDto
import uk.co.prisom.directbanking.data.remote.dto.StatementPreviewResponse

/** Uploads and manages statement-import sessions (Phase 5). The backend is canonical. */
class StatementRepository(private val clients: ApiClients) {
    suspend fun upload(accountId: String, filename: String, fileType: String, contentBase64: String, institution: String? = null): StatementImportDto =
        clients.authApi.createStatement(StatementCreateRequest(accountId, filename, fileType, contentBase64, institution)).import

    suspend fun list(): List<StatementImportDto> = clients.authApi.listStatements().items

    suspend fun preview(id: String): StatementPreviewResponse = clients.authApi.previewStatement(id)

    suspend fun import(id: String, excludeRowIndexes: List<Int>, rebuildBalance: Boolean = false): StatementImportResultDto =
        clients.authApi.importStatement(id, StatementImportRequest(excludeRowIndexes, rebuildBalance)).result

    suspend fun delete(id: String) { clients.authApi.deleteStatement(id) }
}
