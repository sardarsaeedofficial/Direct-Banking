package uk.co.prisom.directbanking.data

import android.app.Application
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import uk.co.prisom.directbanking.data.local.db.DirectBankingDatabase

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class RoomMigrationTest {

    private val context get() = RuntimeEnvironment.getApplication()

    private fun openV1(name: String): SupportSQLiteDatabase {
        context.deleteDatabase(name)
        val config = SupportSQLiteOpenHelper.Configuration.builder(context)
            .name(name)
            .callback(object : SupportSQLiteOpenHelper.Callback(1) {
                override fun onCreate(db: SupportSQLiteDatabase) {
                    // v1 approved_source has no `ignored` column.
                    db.execSQL(
                        "CREATE TABLE `approved_source` (`packageName` TEXT NOT NULL, `label` TEXT NOT NULL, " +
                            "`approved` INTEGER NOT NULL, `firstObservedMillis` INTEGER NOT NULL, " +
                            "`lastSeenMillis` INTEGER NOT NULL, PRIMARY KEY(`packageName`))",
                    )
                    db.execSQL(
                        "CREATE TABLE `pending_sync_op` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
                            "`type` TEXT NOT NULL, `fingerprint` TEXT, `remoteId` TEXT, `payloadJson` TEXT NOT NULL, " +
                            "`attempts` INTEGER NOT NULL, `lastError` TEXT, `createdAtMillis` INTEGER NOT NULL)",
                    )
                    db.execSQL(
                        "CREATE TABLE `parsed_import` (`fingerprint` TEXT NOT NULL, `sourcePackage` TEXT NOT NULL, " +
                            "`direction` TEXT NOT NULL, `amountMinor` INTEGER NOT NULL, `currency` TEXT NOT NULL, " +
                            "`merchant` TEXT, `accountHint` TEXT, `occurredAtMillis` INTEGER NOT NULL, `confidence` REAL NOT NULL, " +
                            "`reviewState` TEXT NOT NULL, `redactedText` TEXT NOT NULL, `title` TEXT NOT NULL, " +
                            "`localStatus` TEXT NOT NULL, `remoteId` TEXT, `createdAtMillis` INTEGER NOT NULL, PRIMARY KEY(`fingerprint`))",
                    )
                }
                override fun onUpgrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
            })
            .build()
        return FrameworkSQLiteOpenHelperFactory().create(config).writableDatabase
    }

    /** Opens a v2 database: approved_source now carries the `ignored` column added in 1→2. */
    private fun openV2(name: String): SupportSQLiteDatabase {
        context.deleteDatabase(name)
        val config = SupportSQLiteOpenHelper.Configuration.builder(context)
            .name(name)
            .callback(object : SupportSQLiteOpenHelper.Callback(2) {
                override fun onCreate(db: SupportSQLiteDatabase) {
                    db.execSQL(
                        "CREATE TABLE `approved_source` (`packageName` TEXT NOT NULL, `label` TEXT NOT NULL, " +
                            "`approved` INTEGER NOT NULL, `firstObservedMillis` INTEGER NOT NULL, " +
                            "`lastSeenMillis` INTEGER NOT NULL, `ignored` INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(`packageName`))",
                    )
                }
                override fun onUpgrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
            })
            .build()
        return FrameworkSQLiteOpenHelperFactory().create(config).writableDatabase
    }

    @Test
    fun `migration 1 to 2 adds ignored column and preserves data`() {
        val db = openV1("mig-test.db")
        db.execSQL("INSERT INTO approved_source VALUES ('com.bank', 'Bank', 1, 100, 200)")
        db.execSQL("INSERT INTO pending_sync_op VALUES (1, 'CREATE_IMPORT', 'fp1', NULL, '{}', 0, NULL, 300)")
        db.execSQL("INSERT INTO parsed_import VALUES ('fp1','com.bank','EXPENSE',1245,'GBP','Tesco',NULL,1000,0.95,'DRAFT','txt','Tesco','LOCAL',NULL,500)")

        DirectBankingDatabase.MIGRATION_1_2.migrate(db)

        // Existing approved source is preserved, and now has the ignored flag (default 0).
        db.query("SELECT approved, ignored FROM approved_source WHERE packageName='com.bank'").use { c ->
            c.moveToFirst()
            assertEquals(1, c.getInt(0)) // still approved
            assertEquals(0, c.getInt(1)) // not ignored by default
        }
        // Queued imports and parsed drafts survive the upgrade.
        db.query("SELECT COUNT(*) FROM pending_sync_op").use { c -> c.moveToFirst(); assertEquals(1, c.getInt(0)) }
        db.query("SELECT COUNT(*) FROM parsed_import").use { c -> c.moveToFirst(); assertEquals(1, c.getInt(0)) }

        // Ignored flag is usable and persists.
        db.execSQL("UPDATE approved_source SET ignored = 1 WHERE packageName='com.bank'")
        db.query("SELECT ignored FROM approved_source WHERE packageName='com.bank'").use { c ->
            c.moveToFirst(); assertEquals(1, c.getInt(0))
        }
        db.close()
    }

    @Test
    fun `migration 2 to 3 adds auto-import columns and preserves data`() {
        val db = openV2("mig-test-2-3.db")
        db.execSQL("INSERT INTO approved_source VALUES ('com.bank', 'Bank', 1, 100, 200, 0)")

        DirectBankingDatabase.MIGRATION_2_3.migrate(db)

        // Existing source is preserved and gains the four auto-import columns with safe defaults.
        db.query(
            "SELECT approved, ignored, autoImportEnabled, requireReview, defaultAccountId, isBuiltInTrusted " +
                "FROM approved_source WHERE packageName='com.bank'",
        ).use { c ->
            c.moveToFirst()
            assertEquals(1, c.getInt(0)) // still approved
            assertEquals(0, c.getInt(1)) // still not ignored
            assertEquals(0, c.getInt(2)) // auto-import off by default (opt-in)
            assertEquals(0, c.getInt(3)) // require-review off by default
            assertEquals(true, c.isNull(4)) // no linked account by default
            assertEquals(0, c.getInt(5)) // not a built-in trusted source by default
        }

        // The new columns are writable and persist (approving a source with a linked account).
        db.execSQL(
            "UPDATE approved_source SET autoImportEnabled = 1, defaultAccountId = 'acc1', isBuiltInTrusted = 1 " +
                "WHERE packageName='com.bank'",
        )
        db.query("SELECT autoImportEnabled, defaultAccountId, isBuiltInTrusted FROM approved_source WHERE packageName='com.bank'").use { c ->
            c.moveToFirst()
            assertEquals(1, c.getInt(0))
            assertEquals("acc1", c.getString(1))
            assertEquals(1, c.getInt(2))
        }
        db.close()
    }
}
