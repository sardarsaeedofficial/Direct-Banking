package uk.co.prisom.directbanking.data.repository

import kotlinx.coroutines.flow.Flow
import uk.co.prisom.directbanking.data.local.db.ApprovedSourceEntity
import uk.co.prisom.directbanking.data.local.db.SourceDao
import uk.co.prisom.directbanking.data.local.db.SourceWithCount

/** A candidate account for mapping (id + name), used by auto-mapping. */
data class AccountRef(val id: String, val name: String, val bankName: String)

/** User-controlled allowlist + auto-import configuration for notification sources. */
class SourceRepository(
    private val sourceDao: SourceDao,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    fun observeSources(): Flow<List<ApprovedSourceEntity>> = sourceDao.observeAll()
    fun observeSourcesWithCounts(): Flow<List<SourceWithCount>> = sourceDao.observeWithCounts()

    suspend fun get(packageName: String): ApprovedSourceEntity? = sourceDao.get(packageName)

    /** Record that a source was seen — label only, never notification text. */
    suspend fun recordObserved(packageName: String, label: String) {
        val now = clock()
        val existing = sourceDao.get(packageName)
        if (existing == null) {
            sourceDao.upsert(ApprovedSourceEntity(packageName, label, approved = false, firstObservedMillis = now, lastSeenMillis = now))
        } else {
            sourceDao.touch(packageName, now)
        }
    }

    /** Approve a source, enabling automatic import and mapping it to an account. */
    suspend fun approveWithAccount(packageName: String, accountId: String?) {
        sourceDao.setApproved(packageName, true)
        sourceDao.setAutoImport(packageName, true)
        if (accountId != null) sourceDao.setLinkedAccount(packageName, accountId)
    }

    suspend fun setApproved(packageName: String, approved: Boolean) = sourceDao.setApproved(packageName, approved)
    suspend fun setIgnored(packageName: String, ignored: Boolean) = sourceDao.setIgnored(packageName, ignored)
    suspend fun setAutoImport(packageName: String, enabled: Boolean) = sourceDao.setAutoImport(packageName, enabled)
    suspend fun setRequireReview(packageName: String, required: Boolean) = sourceDao.setRequireReview(packageName, required)
    suspend fun setLinkedAccount(packageName: String, accountId: String?) = sourceDao.setLinkedAccount(packageName, accountId)
    suspend fun isApproved(packageName: String): Boolean = sourceDao.isApproved(packageName) == true

    /**
     * Auto-map approved sources that have no linked account yet:
     *  - exactly one account whose name/bank matches the source name → map it;
     *  - or the user has exactly one account → map it.
     * Never guesses when several accounts could match. Returns the packages that
     * still need the user to choose an account.
     */
    suspend fun autoMapAccounts(accounts: List<AccountRef>): List<String> {
        val needsChoice = mutableListOf<String>()
        for (src in sourceDao.approvedWithoutAccount()) {
            val match = when {
                accounts.size == 1 -> accounts.first()
                else -> {
                    val name = src.label.lowercase()
                    val matches = accounts.filter { it.name.lowercase().contains(name) || it.bankName.lowercase().contains(name) }
                    matches.singleOrNull()
                }
            }
            if (match != null) sourceDao.setLinkedAccount(src.packageName, match.id) else needsChoice += src.packageName
        }
        return needsChoice
    }
}
