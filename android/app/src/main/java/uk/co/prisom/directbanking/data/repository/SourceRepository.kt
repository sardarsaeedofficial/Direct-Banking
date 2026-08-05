package uk.co.prisom.directbanking.data.repository

import kotlinx.coroutines.flow.Flow
import uk.co.prisom.directbanking.data.local.db.ApprovedSourceEntity
import uk.co.prisom.directbanking.data.local.db.SourceDao

/** User-controlled allowlist of notification sources. */
class SourceRepository(
    private val sourceDao: SourceDao,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    fun observeSources(): Flow<List<ApprovedSourceEntity>> = sourceDao.observeAll()

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

    suspend fun setApproved(packageName: String, approved: Boolean) = sourceDao.setApproved(packageName, approved)
    suspend fun isApproved(packageName: String): Boolean = sourceDao.isApproved(packageName) == true
}
