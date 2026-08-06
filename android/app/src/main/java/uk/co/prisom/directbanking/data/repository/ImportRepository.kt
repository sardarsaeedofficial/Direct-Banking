package uk.co.prisom.directbanking.data.repository

import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import uk.co.prisom.directbanking.data.local.db.ApprovedSourceEntity
import uk.co.prisom.directbanking.data.local.db.ImportDao
import uk.co.prisom.directbanking.data.local.db.ParsedImportEntity
import uk.co.prisom.directbanking.data.local.db.PendingSyncOpEntity
import uk.co.prisom.directbanking.data.local.db.SourceDao
import uk.co.prisom.directbanking.data.local.db.SyncDao
import uk.co.prisom.directbanking.data.local.security.TokenStore
import uk.co.prisom.directbanking.data.remote.dto.NotifImportPatchRequest
import uk.co.prisom.directbanking.data.remote.dto.NotifImportRequest
import uk.co.prisom.directbanking.notifications.RawNotification
import uk.co.prisom.directbanking.parsing.Fingerprint
import uk.co.prisom.directbanking.parsing.NotificationInput
import uk.co.prisom.directbanking.parsing.ParserRegistry
import uk.co.prisom.directbanking.parsing.SourceFilter
import java.time.Instant

/** Outcome of processing one notification, with an exact human-readable [reason]. */
sealed interface CaptureResult {
    val reason: String
    data object Denylisted : CaptureResult { override val reason = "denylisted" }
    data object ConsentDisabled : CaptureResult { override val reason = "consent disabled" }
    data object SourceIgnored : CaptureResult { override val reason = "source permanently ignored" }
    data object SourceNotApproved : CaptureResult { override val reason = "source unapproved" }
    data object EmptyText : CaptureResult { override val reason = "empty text" }
    data object Unparsed : CaptureResult { override val reason = "unsupported package / parse failure" }
    data object Duplicate : CaptureResult { override val reason = "duplicate" }
    data class Stored(
        val reviewState: String,
        val autoQueued: Boolean,
        val amountMinor: Long,
        val currency: String,
        val merchant: String?,
    ) : CaptureResult {
        override val reason: String get() = if (autoQueued) "queued ($reviewState)" else "stored ($reviewState)"
    }
}

/**
 * Turns an approved-source notification into a locally-stored, review-ready draft
 * and (for confidence >= 0.60) queues an idempotent upload. Confidence < 0.60 is
 * kept locally as Unrecognised and never auto-synced. Review-before-import is
 * always preserved: nothing becomes a confirmed transaction without approval.
 */
class ImportRepository(
    private val importDao: ImportDao,
    private val syncDao: SyncDao,
    private val sourceDao: SourceDao,
    private val tokenStore: TokenStore,
    private val parser: ParserRegistry,
    private val json: Json,
    // Consent gate: the user must have accepted the in-app disclosure before any
    // notification content is retained. Defaults to true for unit construction.
    private val disclosureAccepted: suspend () -> Boolean = { true },
    private val clock: () -> Long = System::currentTimeMillis,
) {
    fun observeReviewQueue(): Flow<List<ParsedImportEntity>> = importDao.observeReviewQueue()
    fun observeAll(): Flow<List<ParsedImportEntity>> = importDao.observeAll()

    suspend fun capture(raw: RawNotification, appLabel: String): CaptureResult {
        val input = NotificationInput(raw.packageName, raw.postTime, raw.title, raw.text, raw.bigText, raw.textLines, raw.subText)
        val combined = input.combinedText

        // Enforcement order (each yields an exact diagnostics reason):
        if (!SourceFilter.passesBaseline(raw.packageName, combined)) return CaptureResult.Denylisted
        if (!disclosureAccepted()) return CaptureResult.ConsentDisabled
        if (sourceDao.get(raw.packageName)?.ignored == true) return CaptureResult.SourceIgnored

        // Record the source (label only — no notification text) so the user can approve it.
        recordObserved(raw.packageName, appLabel)
        if (sourceDao.isApproved(raw.packageName) != true) return CaptureResult.SourceNotApproved
        if (combined.isBlank()) return CaptureResult.EmptyText

        val candidate = parser.parse(input) ?: return CaptureResult.Unparsed
        val userId = tokenStore.userId() ?: "local"
        val fingerprint = Fingerprint.compute(
            userId, tokenStore.deviceId, candidate.sourcePackage,
            candidate.amountMinor, candidate.direction, candidate.merchant, raw.postTime,
        )
        // Deduplicate reposted/updated notifications by fingerprint.
        if (importDao.byFingerprint(fingerprint) != null) return CaptureResult.Duplicate

        val reviewState = reviewStateFor(candidate.confidence)
        val entity = ParsedImportEntity(
            fingerprint = fingerprint,
            sourcePackage = candidate.sourcePackage,
            direction = candidate.direction.name,
            amountMinor = candidate.amountMinor,
            currency = candidate.currency,
            merchant = candidate.merchant,
            accountHint = candidate.accountHint,
            occurredAtMillis = raw.postTime,
            confidence = candidate.confidence,
            reviewState = reviewState,
            redactedText = candidate.redactedSourceText,
            title = candidate.merchant ?: appLabel,
            localStatus = "LOCAL",
            remoteId = null,
            createdAtMillis = clock(),
        )
        importDao.upsert(entity)

        val autoQueued = candidate.confidence >= 0.60
        if (autoQueued) enqueueCreate(entity)
        return CaptureResult.Stored(reviewState, autoQueued, candidate.amountMinor, candidate.currency, candidate.merchant)
    }

    suspend fun approve(
        fingerprint: String,
        accountId: String,
        categoryId: String? = null,
        amountMinor: Long? = null,
        direction: String? = null,
        merchant: String? = null,
        occurredAtMillis: Long? = null,
        notes: String? = null,
    ) {
        val e = importDao.byFingerprint(fingerprint) ?: return
        val amt = amountMinor ?: e.amountMinor
        val dir = direction ?: e.direction
        val mer = merchant ?: e.merchant
        val occ = occurredAtMillis ?: e.occurredAtMillis
        importDao.upsert(e.copy(amountMinor = amt, direction = dir, merchant = mer, occurredAtMillis = occ, localStatus = "APPROVED"))

        // Unrecognised items were never queued; ensure the server has the import first.
        if (e.confidence < 0.60 && e.remoteId == null) enqueueCreate(e.copy(amountMinor = amt, direction = dir, merchant = mer, occurredAtMillis = occ))

        val req = NotifImportPatchRequest(
            action = "approve", amountMinor = amt, direction = dir, merchant = mer,
            occurredAt = Instant.ofEpochMilli(occ).toString(), accountId = accountId, categoryId = categoryId, notes = notes,
        )
        syncDao.insert(PendingSyncOpEntity(type = "APPROVE", fingerprint = fingerprint, payloadJson = json.encodeToString(req), createdAtMillis = clock()))
    }

    suspend fun reject(fingerprint: String) {
        val e = importDao.byFingerprint(fingerprint) ?: return
        importDao.upsert(e.copy(localStatus = "REJECTED"))
        if (e.remoteId != null) {
            val req = NotifImportPatchRequest(action = "reject")
            syncDao.insert(PendingSyncOpEntity(type = "REJECT", fingerprint = fingerprint, remoteId = e.remoteId, payloadJson = json.encodeToString(req), createdAtMillis = clock()))
        } else {
            syncDao.deletePendingCreate(fingerprint) // never synced; just drop the queued create
        }
    }

    /** Permanently ignore a source: it will never be parsed or suggested again. */
    suspend fun markSourceIgnored(packageName: String) = sourceDao.setIgnored(packageName, true)

    private suspend fun recordObserved(packageName: String, label: String) {
        val now = clock()
        val existing = sourceDao.get(packageName)
        if (existing == null) {
            sourceDao.upsert(ApprovedSourceEntity(packageName, label, approved = false, firstObservedMillis = now, lastSeenMillis = now))
        } else {
            sourceDao.touch(packageName, now)
        }
    }

    private suspend fun enqueueCreate(entity: ParsedImportEntity) {
        val req = NotifImportRequest(
            fingerprint = entity.fingerprint,
            sourcePackage = entity.sourcePackage,
            direction = entity.direction,
            amountMinor = entity.amountMinor,
            currency = entity.currency,
            merchant = entity.merchant,
            accountHint = entity.accountHint,
            occurredAt = Instant.ofEpochMilli(entity.occurredAtMillis).toString(),
            confidence = entity.confidence,
            redactedSourceText = entity.redactedText,
            title = entity.title,
        )
        syncDao.insert(PendingSyncOpEntity(type = "CREATE_IMPORT", fingerprint = entity.fingerprint, payloadJson = json.encodeToString(req), createdAtMillis = clock()))
    }

    companion object {
        fun reviewStateFor(confidence: Double): String = when {
            confidence >= 0.90 -> "DRAFT"
            confidence >= 0.60 -> "REVIEW_REQUIRED"
            else -> "UNRECOGNISED"
        }
    }
}
