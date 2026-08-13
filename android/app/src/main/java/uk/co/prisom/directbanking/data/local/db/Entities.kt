package uk.co.prisom.directbanking.data.local.db

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/** A parsed import awaiting review/sync. Fingerprint is the local dedupe key. */
@Entity(tableName = "parsed_import", indices = [Index(value = ["reviewState"]), Index(value = ["localStatus"])])
data class ParsedImportEntity(
    @PrimaryKey val fingerprint: String,
    val sourcePackage: String,
    val direction: String,
    val amountMinor: Long,
    val currency: String,
    val merchant: String?,
    val accountHint: String?,
    val occurredAtMillis: Long,
    val confidence: Double,
    val reviewState: String, // DRAFT | REVIEW_REQUIRED | UNRECOGNISED
    val redactedText: String,
    val title: String,
    val localStatus: String, // LOCAL | SYNCED | APPROVED | REJECTED
    val remoteId: String? = null,
    val createdAtMillis: Long,
    // Phase 1 enrichment (additive; null when the notification didn't contain it).
    val senderName: String? = null,
    val recipientName: String? = null,
    val paymentReference: String? = null,
    val paymentReason: String? = null,
)

/**
 * Transient raw-ish capture (already redacted) kept only until the item is
 * parsed and synced, unless the user chose to keep it for review.
 */
@Entity(tableName = "captured_notification")
data class CapturedNotificationEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val sourcePackage: String,
    val postTime: Long,
    val title: String?,
    val redactedText: String,
    val capturedAtMillis: Long,
    val processed: Boolean = false,
)

/** A queued, idempotent operation to replay against the backend. */
@Entity(tableName = "pending_sync_op")
data class PendingSyncOpEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val type: String, // CREATE_IMPORT | APPROVE | REJECT | DELETE
    val fingerprint: String? = null,
    val remoteId: String? = null,
    val payloadJson: String,
    val attempts: Int = 0,
    val lastError: String? = null,
    val createdAtMillis: Long,
)

/** A notification source the user has observed and may approve for import. */
@Entity(tableName = "approved_source")
data class ApprovedSourceEntity(
    @PrimaryKey val packageName: String,
    val label: String,
    val approved: Boolean = false,
    val ignored: Boolean = false, // user chose to permanently ignore this source
    val firstObservedMillis: Long,
    val lastSeenMillis: Long,
    // Automatic-import configuration (feature/automatic-approved-source-imports).
    val autoImportEnabled: Boolean = false,
    val requireReview: Boolean = false, // when true, always queue under Review
    val defaultAccountId: String? = null, // Direct Banking account this source maps to
    val isBuiltInTrusted: Boolean = false,
)

/**
 * Phase 2 offline cache of upcoming Direct Debit payments so the Home screen can
 * render without a network round-trip. The backend remains the canonical source;
 * this is refreshed write-through whenever upcoming payments are fetched.
 */
@Entity(tableName = "upcoming_payment_cache")
data class UpcomingPaymentEntity(
    @PrimaryKey val mandateId: String,
    val companyName: String,
    val account: String,
    val expectedDate: String?, // ISO-8601
    val expectedAmountMinor: Long,
    val cachedAtMillis: Long,
)

/**
 * Phase 3 offline cache of the user's bank connections so the connections screen
 * can render without a network round-trip. The backend remains canonical.
 */
@Entity(tableName = "bank_connection_cache")
data class BankConnectionCacheEntity(
    @PrimaryKey val id: String,
    val provider: String,
    val status: String,
    val institutionName: String?,
    val lastSuccessfulSyncAt: String?,
    val cachedAtMillis: Long,
)

/**
 * Phase 4 offline cache of insights payloads (Home overview, budget & recurring
 * summaries) as raw JSON, keyed by a stable name (e.g. "overview"). Lets those
 * screens render last-known data without a network round-trip; the backend remains
 * canonical and staleness is surfaced from cachedAtMillis. Additive — no existing
 * data is touched.
 */
@Entity(tableName = "insights_cache")
data class InsightsCacheEntity(
    @PrimaryKey val key: String,
    val json: String,
    val cachedAtMillis: Long,
)
