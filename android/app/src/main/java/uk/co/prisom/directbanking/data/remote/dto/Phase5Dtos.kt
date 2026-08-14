package uk.co.prisom.directbanking.data.remote.dto

import kotlinx.serialization.Serializable

// Phase 5 — statement import, review centre, transfer pairing. Partial DTOs (the
// API's JSON reader ignores unknown keys). Money is minor units; some review fields
// arrive as strings (BigInt-safe) and are parsed on the client.

// ── Statement import ────────────────────────────────────────────────────────────
@Serializable
data class StatementImportDto(
    val id: String,
    val accountId: String = "",
    val filename: String = "",
    val fileType: String = "CSV",
    val institution: String? = null,
    val status: String = "UPLOADED",
    val transactionCount: Int = 0,
    val importedCount: Int = 0,
    val duplicateCount: Int = 0,
    val reviewCount: Int = 0,
    val periodStart: String? = null,
    val periodEnd: String? = null,
    val error: String? = null,
    val createdAt: String? = null,
    val completedAt: String? = null,
)

@Serializable data class StatementListResponse(val items: List<StatementImportDto> = emptyList())
@Serializable data class StatementImportResponse(val import: StatementImportDto)

@Serializable
data class StatementCreateRequest(
    val accountId: String,
    val filename: String,
    val fileType: String,
    val contentBase64: String,
    val institution: String? = null,
)

@Serializable
data class StatementPreviewRow(
    val id: String,
    val rowIndex: Int,
    val bookedAt: String = "",
    val amountMinor: Long = 0,
    val currency: String = "GBP",
    val direction: String = "EXPENSE",
    val description: String = "",
    val reference: String? = null,
    val reconStatus: String = "NEW",
    val excluded: Boolean = false,
)

@Serializable
data class StatementPreviewSummary(
    val found: Int = 0,
    val newCount: Int = 0,
    val duplicateCount: Int = 0,
    val reviewCount: Int = 0,
)

@Serializable
data class StatementPreviewResponse(
    val import: StatementImportDto,
    val summary: StatementPreviewSummary = StatementPreviewSummary(),
    val rows: List<StatementPreviewRow> = emptyList(),
)

@Serializable
data class StatementImportRequest(
    val excludeRowIndexes: List<Int> = emptyList(),
    val rebuildBalance: Boolean = false,
)

@Serializable
data class StatementImportResultDto(
    val imported: Int = 0,
    val matched: Int = 0,
    val duplicates: Int = 0,
    val review: Int = 0,
    val skipped: Int = 0,
    val total: Int = 0,
)

@Serializable
data class StatementImportResultResponse(
    val import: StatementImportDto,
    val result: StatementImportResultDto = StatementImportResultDto(),
)

// ── Review centre ───────────────────────────────────────────────────────────────
@Serializable
data class ReviewTxnBrief(
    val id: String,
    val description: String = "",
    val merchantName: String? = null,
    val amountMinor: String = "0",
    val direction: String = "EXPENSE",
    val currency: String = "GBP",
    val bookedAt: String? = null,
    val source: String = "MANUAL",
    val accountName: String? = null,
)

@Serializable data class ReviewDupPair(val transaction: ReviewTxnBrief, val match: ReviewTxnBrief)

@Serializable
data class ReviewSubscriptionDto(
    val merchantId: String = "",
    val merchantName: String = "",
    val averageAmountMinor: String = "0",
    val intervalDays: Int = 0,
    val occurrences: Int = 0,
    val confidence: String = "POSSIBLE",
)

@Serializable
data class ReviewCounts(
    val possibleDuplicates: Int = 0,
    val uncertainStatementMatches: Int = 0,
    val possibleInternalTransfers: Int = 0,
    val possibleSubscriptions: Int = 0,
    val uncategorized: Int = 0,
)

@Serializable
data class ReviewCentreDto(
    val possibleDuplicates: List<ReviewDupPair> = emptyList(),
    val uncertainStatementMatches: List<ReviewDupPair> = emptyList(),
    val possibleInternalTransfers: List<ReviewTxnBrief> = emptyList(),
    val possibleSubscriptions: List<ReviewSubscriptionDto> = emptyList(),
    val uncategorized: List<ReviewTxnBrief> = emptyList(),
    val counts: ReviewCounts = ReviewCounts(),
)

@Serializable data class PairRequest(val transactionAId: String, val transactionBId: String)
@Serializable data class UnpairRequest(val transactionId: String)

// Loose action response — pair/unpair/merge/keep-separate return small objects.
@Serializable
data class ActionResponse(
    val groupId: String? = null,
    val transactionIds: List<String> = emptyList(),
    val canonicalId: String? = null,
    val mergedId: String? = null,
    val keptSeparate: List<String> = emptyList(),
)
