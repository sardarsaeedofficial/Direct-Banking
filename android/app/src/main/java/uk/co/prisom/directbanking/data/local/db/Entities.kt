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
)
