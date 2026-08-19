package uk.co.prisom.directbanking.data.repository

import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import uk.co.prisom.directbanking.data.SignatureInspector
import uk.co.prisom.directbanking.data.SourceTrust
import uk.co.prisom.directbanking.data.SourceTrustLevel
import uk.co.prisom.directbanking.data.TrustedSources
import uk.co.prisom.directbanking.data.local.db.ApprovedSourceEntity
import uk.co.prisom.directbanking.data.local.db.CapturedDao
import uk.co.prisom.directbanking.data.local.db.CapturedNotificationEntity
import uk.co.prisom.directbanking.data.local.db.ImportDao
import uk.co.prisom.directbanking.data.local.db.ParsedImportEntity
import uk.co.prisom.directbanking.data.local.db.PendingSyncOpEntity
import uk.co.prisom.directbanking.data.local.db.SourceDao
import uk.co.prisom.directbanking.data.local.db.SyncDao
import uk.co.prisom.directbanking.data.local.security.TokenStore
import uk.co.prisom.directbanking.data.remote.dto.NotifAutoImportRequest
import uk.co.prisom.directbanking.data.remote.dto.NotifImportPatchRequest
import uk.co.prisom.directbanking.data.remote.dto.NotifImportRequest
import uk.co.prisom.directbanking.notifications.RawNotification
import uk.co.prisom.directbanking.parsing.Fingerprint
import uk.co.prisom.directbanking.parsing.NotificationInput
import uk.co.prisom.directbanking.parsing.ParserRegistry
import uk.co.prisom.directbanking.parsing.SourceFilter
import uk.co.prisom.directbanking.parsing.TransactionClassifier
import java.time.Instant

/** Result states for one processed notification. */
enum class ImportOutcome {
    AUTO_IMPORTED, REVIEW_REQUIRED, SETUP_REQUIRED, DUPLICATE, REJECTED, SYNC_FAILED,
    /** Recognised correctly (amount/merchant/card hint) but no account could be
     *  resolved — distinct from SETUP_REQUIRED (which has no candidate data at
     *  all) so the UI can show the real parsed details instead of a blank/zero
     *  placeholder. See AutoImportResult.AccountMappingRequired. */
    ACCOUNT_MAPPING_REQUIRED,
}

/** Rich outcome carrying everything diagnostics needs. */
data class CaptureOutcome(
    val outcome: ImportOutcome,
    val reason: String,
    val sourceName: String? = null,
    val trustedOrApproved: Boolean = false,
    val autoImportEnabled: Boolean = false,
    val linkedAccountId: String? = null,
    val amountMinor: Long? = null,
    val currency: String? = null,
    val direction: String? = null,
    val merchant: String? = null,
    val confidence: Double? = null,
    val fingerprint: String? = null,
    val transactionId: String? = null,
    val trustLevel: String? = null,
    val builtInTrusted: Boolean = false,
    val signatureChecked: Boolean = false,
    val signatureMatched: Boolean? = null,
    val signingSha256Abbrev: String? = null,
    // ---- Diagnostics-only (never affects parsing/classification behaviour) ----
    /** Which parser matched this source ("CapitalOneParser", "MonzoParser",
     *  "Generic", …) — added so an unrecognised-bank capture can be diagnosed
     *  without needing to expose the full notification body. */
    val parserSelected: String? = null,
    /** How many distinct currency-signalled amounts the notification text
     *  contained (a multi-amount notification like "£4.88 … £202.51 available
     *  to spend" is exactly the shape that used to silently fail). */
    val amountCandidateCount: Int? = null,
)

/** Result of the injected atomic auto-import call. */
sealed interface AutoImportResult {
    data class Imported(val transactionId: String, val remoteId: String) : AutoImportResult
    data class Duplicate(val transactionId: String?) : AutoImportResult
    /** The notification was recognised (correct amount/merchant/card hint) but
     *  no account could be resolved — zero or more than one of the user's own
     *  accounts matched the card/account hint. Never silently attached to an
     *  unrelated already-configured account. [remoteId] is the server-side
     *  NotificationImport id, already reviewable/approvable via the existing
     *  approve flow once the user picks or creates the right account. */
    data class AccountMappingRequired(val remoteId: String) : AutoImportResult
    data object Failed : AutoImportResult
}

/**
 * Decides, for each captured notification, whether to auto-import directly, queue
 * for Review, ask for setup, or reject. Built-in trusted banks auto-approve and
 * auto-import; unknown sources need one-time approval + account mapping first.
 * Review-before-import is preserved for anything ambiguous.
 */
class ImportRepository(
    private val importDao: ImportDao,
    private val syncDao: SyncDao,
    private val sourceDao: SourceDao,
    private val capturedDao: CapturedDao,
    private val tokenStore: TokenStore,
    private val parser: ParserRegistry,
    private val json: Json,
    private val autoImport: suspend (NotifAutoImportRequest) -> AutoImportResult = { AutoImportResult.Failed },
    private val disclosureAccepted: suspend () -> Boolean = { true },
    private val resolveTrust: (packageName: String, userApproved: Boolean) -> SourceTrust =
        { pkg, approved -> TrustedSources.resolveTrust(SignatureInspector.None, pkg, approved) },
    private val clock: () -> Long = System::currentTimeMillis,
) {
    fun observeReviewQueue(): Flow<List<ParsedImportEntity>> = importDao.observeReviewQueue()
    fun observeAll(): Flow<List<ParsedImportEntity>> = importDao.observeAll()

    suspend fun capture(raw: RawNotification, appLabel: String): CaptureOutcome {
        val input = NotificationInput(raw.packageName, raw.postTime, raw.title, raw.text, raw.bigText, raw.textLines, raw.subText)
        val combined = input.combinedText

        if (!SourceFilter.passesBaseline(raw.packageName, combined)) return rejected("denylisted")
        if (!disclosureAccepted()) return rejected("consent disabled")
        val existing = sourceDao.get(raw.packageName)
        if (existing?.ignored == true) return rejected("source permanently ignored")

        // Classify the source (built-in signature check / user approval) once per capture.
        val trust = resolveTrust(raw.packageName, existing?.approved ?: false)
        val src = ensureSource(existing, raw.packageName, appLabel, trust)
        val sourceName = src.label

        // Diagnostics only (never used to change parsing/classification) — which
        // parser would handle this source, and how many distinct currency
        // amounts its text carries, so a future unrecognised-bank capture is
        // diagnosable without needing to expose the full notification body.
        val parserSelected = parser.selectedParserName(raw.packageName)
        val amountCandidateCount = uk.co.prisom.directbanking.parsing.Money.countAmounts(combined)

        // Stamps the trust classification onto any outcome produced past this point.
        fun CaptureOutcome.tagged() = copy(
            trustLevel = trust.level.name,
            builtInTrusted = src.isBuiltInTrusted,
            signatureChecked = trust.signatureChecked,
            signatureMatched = trust.signatureMatched,
            signingSha256Abbrev = trust.signingSha256Abbrev,
            parserSelected = parserSelected,
            amountCandidateCount = amountCandidateCount,
        )

        if (!src.approved) {
            rememberLatest(raw, combined) // keep for reprocessing on approval
            return CaptureOutcome(ImportOutcome.SETUP_REQUIRED, "source unapproved", sourceName, trustedOrApproved = false, autoImportEnabled = src.autoImportEnabled).tagged()
        }
        if (combined.isBlank()) return rejected("empty text", sourceName).tagged()
        if (TransactionClassifier.isNonTransaction(combined)) return rejected("non-transaction notification", sourceName).tagged()

        val candidate = parser.parse(input)
        if (candidate == null) {
            // Ambiguous (missing amount or undetermined direction) → Review, never auto.
            val fp = "amb-" + Fingerprint.compute(userId(), tokenStore.deviceId, raw.packageName, 0, uk.co.prisom.directbanking.parsing.TransactionDirection.EXPENSE, combined.take(40), raw.postTime)
            if (importDao.byFingerprint(fp) == null) {
                importDao.upsert(
                    ParsedImportEntity(
                        fingerprint = fp, sourcePackage = raw.packageName, direction = "EXPENSE", amountMinor = 0,
                        currency = "GBP", merchant = null, accountHint = null, occurredAtMillis = raw.postTime,
                        confidence = 0.0, reviewState = "UNRECOGNISED", redactedText = redactedOf(combined),
                        title = sourceName, localStatus = "LOCAL", remoteId = null, createdAtMillis = clock(),
                    ),
                )
            }
            return CaptureOutcome(ImportOutcome.REVIEW_REQUIRED, "missing amount or direction", sourceName, trustedOrApproved = true, autoImportEnabled = src.autoImportEnabled, fingerprint = fp).tagged()
        }

        val fingerprint = Fingerprint.compute(userId(), tokenStore.deviceId, candidate.sourcePackage, candidate.amountMinor, candidate.direction, candidate.merchant, raw.postTime)
        if (importDao.byFingerprint(fingerprint) != null) {
            return CaptureOutcome(ImportOutcome.DUPLICATE, "duplicate", sourceName, fingerprint = fingerprint).tagged()
        }

        val accountId = src.defaultAccountId
        val base = CaptureOutcome(
            outcome = ImportOutcome.REVIEW_REQUIRED, reason = "", sourceName = sourceName, trustedOrApproved = true,
            autoImportEnabled = src.autoImportEnabled, linkedAccountId = accountId, amountMinor = candidate.amountMinor,
            currency = candidate.currency, direction = candidate.direction.name, merchant = candidate.merchant,
            confidence = candidate.confidence, fingerprint = fingerprint,
        ).tagged()

        // Trusted/auto source with no per-source default account mapped.
        if (accountId == null && (src.isBuiltInTrusted || src.autoImportEnabled)) {
            // A card/account hint ("card ending 7813") gives the server enough
            // signal to resolve the right account itself — exactly one of the
            // user's own accounts matching the hint — or to record a properly
            // reviewable item with the already-correct merchant/amount/hint
            // (never a blank/zero placeholder). Only attempted when a hint
            // actually exists; sources with no hint keep the pre-existing,
            // purely-local SETUP_REQUIRED behaviour untouched below.
            if (candidate.accountHint != null) {
                importDao.upsert(entityOf(fingerprint, candidate, raw, "AUTO_PENDING", sourceName))
                val req = autoRequest(fingerprint, candidate, raw, accountId = null, sourceName)
                when (val r = autoImport(req)) {
                    is AutoImportResult.Imported -> {
                        importDao.setStatus(fingerprint, "AUTO_IMPORTED", r.remoteId)
                        capturedDao.deleteForSource(raw.packageName)
                        return base.copy(outcome = ImportOutcome.AUTO_IMPORTED, reason = "auto-imported (account resolved by card/account hint)", transactionId = r.transactionId)
                    }
                    is AutoImportResult.Duplicate -> {
                        importDao.setStatus(fingerprint, "AUTO_IMPORTED", null)
                        return base.copy(outcome = ImportOutcome.DUPLICATE, reason = "duplicate", transactionId = r.transactionId)
                    }
                    is AutoImportResult.AccountMappingRequired -> {
                        importDao.upsert(entityOf(fingerprint, candidate, raw, "LOCAL", sourceName).copy(reviewState = "ACCOUNT_MAPPING_REQUIRED", remoteId = r.remoteId))
                        return base.copy(outcome = ImportOutcome.ACCOUNT_MAPPING_REQUIRED, reason = "select which account this belongs to")
                    }
                    AutoImportResult.Failed -> {
                        // Network/server issue — never lose the notification; fall
                        // back to the existing local-only remember-and-reprocess path.
                        rememberLatest(raw, combined)
                        return base.copy(outcome = ImportOutcome.SETUP_REQUIRED, reason = "account not mapped")
                    }
                }
            }
            rememberLatest(raw, combined)
            return base.copy(outcome = ImportOutcome.SETUP_REQUIRED, reason = "account not mapped")
        }

        val autoEligible = src.autoImportEnabled && !src.requireReview && accountId != null &&
            candidate.confidence >= AUTO_THRESHOLD && candidate.amountMinor > 0

        if (autoEligible) {
            importDao.upsert(entityOf(fingerprint, candidate, raw, "AUTO_PENDING", sourceName))
            val req = autoRequest(fingerprint, candidate, raw, accountId!!, sourceName)
            return when (val r = autoImport(req)) {
                is AutoImportResult.Imported -> {
                    importDao.setStatus(fingerprint, "AUTO_IMPORTED", r.remoteId)
                    capturedDao.deleteForSource(raw.packageName)
                    base.copy(outcome = ImportOutcome.AUTO_IMPORTED, reason = "auto-imported", transactionId = r.transactionId)
                }
                is AutoImportResult.Duplicate -> {
                    importDao.setStatus(fingerprint, "AUTO_IMPORTED", null)
                    base.copy(outcome = ImportOutcome.DUPLICATE, reason = "duplicate", transactionId = r.transactionId)
                }
                is AutoImportResult.AccountMappingRequired -> {
                    // Unreachable in practice: this call always sends an explicit
                    // accountId (accountId!! above), so the server never has to
                    // resolve one — kept only for sealed-interface exhaustiveness.
                    importDao.upsert(entityOf(fingerprint, candidate, raw, "LOCAL", sourceName).copy(reviewState = "ACCOUNT_MAPPING_REQUIRED", remoteId = r.remoteId))
                    base.copy(outcome = ImportOutcome.ACCOUNT_MAPPING_REQUIRED, reason = "select which account this belongs to")
                }
                AutoImportResult.Failed -> {
                    enqueueAuto(fingerprint, candidate, raw, accountId, sourceName)
                    base.copy(outcome = ImportOutcome.SYNC_FAILED, reason = "auto-import failed — queued for retry")
                }
            }
        }

        // Otherwise → Review (auto off, require-review on, or low confidence).
        importDao.upsert(entityOf(fingerprint, candidate, raw, "LOCAL", sourceName))
        if (candidate.confidence >= 0.60) enqueueCreate(fingerprint)
        val reason = when {
            src.requireReview -> "review required (per-source override)"
            !src.autoImportEnabled -> "auto-import disabled"
            else -> "low confidence"
        }
        return base.copy(outcome = ImportOutcome.REVIEW_REQUIRED, reason = reason)
    }

    /** Reprocess the most recently remembered notification for a source (after approval/mapping). */
    suspend fun reprocessLatest(packageName: String, appLabel: String): CaptureOutcome? {
        val last = capturedDao.latestForSource(packageName) ?: return null
        val raw = RawNotification(
            packageName = last.sourcePackage, postTime = last.postTime, key = null, category = null,
            title = last.title, text = last.redactedText, bigText = null, textLines = emptyList(), subText = null,
        )
        val outcome = capture(raw, appLabel)
        if (outcome.outcome != ImportOutcome.SETUP_REQUIRED) capturedDao.deleteForSource(packageName)
        return outcome
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
        if (e.confidence < 0.60 && e.remoteId == null) enqueueCreate(fingerprint)
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
            syncDao.insert(PendingSyncOpEntity(type = "REJECT", fingerprint = fingerprint, remoteId = e.remoteId, payloadJson = json.encodeToString(NotifImportPatchRequest(action = "reject")), createdAtMillis = clock()))
        } else {
            syncDao.deletePendingCreate(fingerprint)
        }
    }

    suspend fun markSourceIgnored(packageName: String) = sourceDao.setIgnored(packageName, true)

    // ── source seeding / helpers ─────────────────────────────────────────────

    private suspend fun ensureSource(
        existing: ApprovedSourceEntity?,
        packageName: String,
        label: String,
        trust: SourceTrust,
    ): ApprovedSourceEntity {
        if (existing != null) {
            sourceDao.touch(packageName, clock())
            return existing
        }
        // Grant built-in trust only when the package is a known bank AND its signature
        // was not rejected against configured pins. A spoof (built-in id, wrong cert →
        // UNAPPROVED) is treated like any unknown source: it must be approved by hand.
        val trustBuiltIn = trust.builtIn && trust.level != SourceTrustLevel.UNAPPROVED
        val now = clock()
        val row = ApprovedSourceEntity(
            packageName = packageName,
            label = if (trust.builtIn) TrustedSources.displayName(packageName) ?: label else label,
            approved = trustBuiltIn,
            ignored = false,
            firstObservedMillis = now,
            lastSeenMillis = now,
            autoImportEnabled = trustBuiltIn,
            requireReview = false,
            defaultAccountId = null,
            isBuiltInTrusted = trustBuiltIn,
        )
        sourceDao.upsert(row)
        return row
    }

    private suspend fun rememberLatest(raw: RawNotification, combined: String) {
        capturedDao.deleteForSource(raw.packageName)
        capturedDao.insert(
            CapturedNotificationEntity(
                sourcePackage = raw.packageName, postTime = raw.postTime, title = raw.title,
                redactedText = redactedOf(combined), capturedAtMillis = clock(),
            ),
        )
    }

    private fun entityOf(fingerprint: String, c: uk.co.prisom.directbanking.parsing.ParsedTransactionCandidate, raw: RawNotification, localStatus: String, sourceName: String) =
        ParsedImportEntity(
            fingerprint = fingerprint, sourcePackage = c.sourcePackage, direction = c.direction.name,
            amountMinor = c.amountMinor, currency = c.currency, merchant = c.merchant, accountHint = c.accountHint,
            occurredAtMillis = raw.postTime, confidence = c.confidence, reviewState = reviewStateFor(c.confidence),
            redactedText = c.redactedSourceText, title = c.merchant ?: sourceName, localStatus = localStatus,
            remoteId = null, createdAtMillis = clock(),
            senderName = c.senderName, recipientName = c.recipientName,
            paymentReference = c.paymentReference, paymentReason = c.paymentReason,
        )

    private fun autoRequest(fingerprint: String, c: uk.co.prisom.directbanking.parsing.ParsedTransactionCandidate, raw: RawNotification, accountId: String?, sourceName: String) =
        NotifAutoImportRequest(
            fingerprint = fingerprint, sourcePackage = c.sourcePackage, direction = c.direction.name,
            amountMinor = c.amountMinor, currency = c.currency, merchant = c.merchant, accountHint = c.accountHint,
            occurredAt = Instant.ofEpochMilli(raw.postTime).toString(), confidence = c.confidence,
            redactedSourceText = c.redactedSourceText, title = c.merchant ?: sourceName, accountId = accountId,
            senderName = c.senderName, recipientName = c.recipientName,
            paymentReference = c.paymentReference, paymentReason = c.paymentReason,
        )

    private suspend fun enqueueAuto(fingerprint: String, c: uk.co.prisom.directbanking.parsing.ParsedTransactionCandidate, raw: RawNotification, accountId: String, sourceName: String) {
        syncDao.insert(PendingSyncOpEntity(type = "AUTO_IMPORT", fingerprint = fingerprint, payloadJson = json.encodeToString(autoRequest(fingerprint, c, raw, accountId, sourceName)), createdAtMillis = clock()))
    }

    private suspend fun enqueueCreate(fingerprint: String) {
        val e = importDao.byFingerprint(fingerprint) ?: return
        val req = NotifImportRequest(
            fingerprint = e.fingerprint, sourcePackage = e.sourcePackage, direction = e.direction, amountMinor = e.amountMinor,
            currency = e.currency, merchant = e.merchant, accountHint = e.accountHint,
            occurredAt = Instant.ofEpochMilli(e.occurredAtMillis).toString(), confidence = e.confidence,
            redactedSourceText = e.redactedText, title = e.title,
        )
        syncDao.insert(PendingSyncOpEntity(type = "CREATE_IMPORT", fingerprint = e.fingerprint, payloadJson = json.encodeToString(req), createdAtMillis = clock()))
    }

    private fun userId(): String = tokenStore.userId() ?: "local"
    private fun redactedOf(text: String): String = uk.co.prisom.directbanking.parsing.Redaction.redact(text)
    private fun rejected(reason: String, sourceName: String? = null) = CaptureOutcome(ImportOutcome.REJECTED, reason, sourceName)

    companion object {
        // A notification is confident enough to auto-import once the parser has a
        // clear amount + direction (0.60+). Ambiguous parses (missing amount or
        // undetermined direction) yield no candidate and go to Review instead.
        const val AUTO_THRESHOLD = 0.60
        fun reviewStateFor(confidence: Double): String = when {
            confidence >= 0.90 -> "DRAFT"
            confidence >= 0.60 -> "REVIEW_REQUIRED"
            else -> "UNRECOGNISED"
        }
    }
}
