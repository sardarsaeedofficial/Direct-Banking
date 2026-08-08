package uk.co.prisom.directbanking.data.local.db

import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface ImportDao {
    @Upsert
    suspend fun upsert(item: ParsedImportEntity)

    @Query("SELECT * FROM parsed_import WHERE fingerprint = :fingerprint")
    suspend fun byFingerprint(fingerprint: String): ParsedImportEntity?

    @Query("SELECT * FROM parsed_import ORDER BY createdAtMillis DESC")
    fun observeAll(): Flow<List<ParsedImportEntity>>

    @Query("SELECT * FROM parsed_import WHERE reviewState IN ('DRAFT','REVIEW_REQUIRED','UNRECOGNISED') AND localStatus NOT IN ('APPROVED','REJECTED','AUTO_IMPORTED','AUTO_PENDING') ORDER BY createdAtMillis DESC")
    fun observeReviewQueue(): Flow<List<ParsedImportEntity>>

    @Query("UPDATE parsed_import SET localStatus = :status, remoteId = :remoteId WHERE fingerprint = :fingerprint")
    suspend fun setStatus(fingerprint: String, status: String, remoteId: String?)

    @Query("DELETE FROM parsed_import WHERE fingerprint = :fingerprint")
    suspend fun delete(fingerprint: String)
}

@Dao
interface CapturedDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(item: CapturedNotificationEntity): Long

    @Query("SELECT * FROM captured_notification WHERE processed = 0 ORDER BY capturedAtMillis ASC")
    suspend fun unprocessed(): List<CapturedNotificationEntity>

    @Query("DELETE FROM captured_notification WHERE id = :id")
    suspend fun delete(id: Long)

    // Keep the most recent (redacted) notification per source so it can be
    // reprocessed immediately after the user approves/maps that source.
    @Query("SELECT * FROM captured_notification WHERE sourcePackage = :pkg ORDER BY capturedAtMillis DESC LIMIT 1")
    suspend fun latestForSource(pkg: String): CapturedNotificationEntity?

    @Query("DELETE FROM captured_notification WHERE sourcePackage = :pkg")
    suspend fun deleteForSource(pkg: String)

    @Query("DELETE FROM captured_notification")
    suspend fun clear()
}

@Dao
interface SyncDao {
    @Insert
    suspend fun insert(op: PendingSyncOpEntity): Long

    @Query("SELECT * FROM pending_sync_op ORDER BY createdAtMillis ASC")
    suspend fun all(): List<PendingSyncOpEntity>

    @Query("SELECT COUNT(*) FROM pending_sync_op")
    fun observeCount(): Flow<Int>

    @Delete
    suspend fun delete(op: PendingSyncOpEntity)

    @Query("UPDATE pending_sync_op SET attempts = attempts + 1, lastError = :error WHERE id = :id")
    suspend fun markFailure(id: Long, error: String?)

    @Query("DELETE FROM pending_sync_op WHERE fingerprint = :fingerprint AND type = 'CREATE_IMPORT'")
    suspend fun deletePendingCreate(fingerprint: String)
}

/** Source row plus a live count of transactions imported from it. */
data class SourceWithCount(
    val packageName: String,
    val label: String,
    val approved: Boolean,
    val ignored: Boolean,
    val autoImportEnabled: Boolean,
    val requireReview: Boolean,
    val defaultAccountId: String?,
    val isBuiltInTrusted: Boolean,
    val firstObservedMillis: Long,
    val lastSeenMillis: Long,
    val importedCount: Int,
)

@Dao
interface SourceDao {
    @Upsert
    suspend fun upsert(source: ApprovedSourceEntity)

    @Query("SELECT * FROM approved_source ORDER BY approved DESC, label ASC")
    fun observeAll(): Flow<List<ApprovedSourceEntity>>

    @Query(
        "SELECT s.packageName, s.label, s.approved, s.ignored, s.autoImportEnabled, s.requireReview, " +
            "s.defaultAccountId, s.isBuiltInTrusted, s.firstObservedMillis, s.lastSeenMillis, " +
            "(SELECT COUNT(*) FROM parsed_import p WHERE p.sourcePackage = s.packageName AND (p.localStatus = 'APPROVED' OR p.localStatus = 'AUTO_IMPORTED')) AS importedCount " +
            "FROM approved_source s ORDER BY s.approved DESC, s.label ASC",
    )
    fun observeWithCounts(): Flow<List<SourceWithCount>>

    @Query("SELECT * FROM approved_source WHERE packageName = :pkg")
    suspend fun get(pkg: String): ApprovedSourceEntity?

    @Query("SELECT approved FROM approved_source WHERE packageName = :pkg")
    suspend fun isApproved(pkg: String): Boolean?

    @Query("UPDATE approved_source SET approved = :approved WHERE packageName = :pkg")
    suspend fun setApproved(pkg: String, approved: Boolean)

    @Query("UPDATE approved_source SET ignored = :ignored, approved = 0, autoImportEnabled = 0 WHERE packageName = :pkg")
    suspend fun setIgnored(pkg: String, ignored: Boolean)

    @Query("UPDATE approved_source SET autoImportEnabled = :enabled WHERE packageName = :pkg")
    suspend fun setAutoImport(pkg: String, enabled: Boolean)

    @Query("UPDATE approved_source SET requireReview = :required WHERE packageName = :pkg")
    suspend fun setRequireReview(pkg: String, required: Boolean)

    @Query("UPDATE approved_source SET defaultAccountId = :accountId WHERE packageName = :pkg")
    suspend fun setLinkedAccount(pkg: String, accountId: String?)

    @Query("SELECT * FROM approved_source WHERE approved = 1 AND defaultAccountId IS NULL AND ignored = 0")
    suspend fun approvedWithoutAccount(): List<ApprovedSourceEntity>

    @Query("UPDATE approved_source SET lastSeenMillis = :now WHERE packageName = :pkg")
    suspend fun touch(pkg: String, now: Long)

    @Query("DELETE FROM approved_source")
    suspend fun clear()
}

@Dao
interface UpcomingDao {
    @Query("SELECT * FROM upcoming_payment_cache ORDER BY expectedDate")
    fun observe(): Flow<List<UpcomingPaymentEntity>>

    @Query("SELECT * FROM upcoming_payment_cache ORDER BY expectedDate")
    suspend fun all(): List<UpcomingPaymentEntity>

    @Upsert
    suspend fun upsertAll(items: List<UpcomingPaymentEntity>)

    @Query("DELETE FROM upcoming_payment_cache")
    suspend fun clear()
}
