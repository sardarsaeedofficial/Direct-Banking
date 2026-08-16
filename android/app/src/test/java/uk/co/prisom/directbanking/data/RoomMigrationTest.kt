package uk.co.prisom.directbanking.data

import android.app.Application
import androidx.room.Room
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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
                    // The fourth v1 table (unchanged by any migration since — present at every version).
                    db.execSQL(
                        "CREATE TABLE `captured_notification` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
                            "`sourcePackage` TEXT NOT NULL, `postTime` INTEGER NOT NULL, `title` TEXT, " +
                            "`redactedText` TEXT NOT NULL, `capturedAtMillis` INTEGER NOT NULL, `processed` INTEGER NOT NULL)",
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

    /** Opens a v3 database with the parsed_import table as it stood before v4. */
    private fun openV3(name: String): SupportSQLiteDatabase {
        context.deleteDatabase(name)
        val config = SupportSQLiteOpenHelper.Configuration.builder(context)
            .name(name)
            .callback(object : SupportSQLiteOpenHelper.Callback(3) {
                override fun onCreate(db: SupportSQLiteDatabase) {
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

    /** Opens a minimal v4 database (the 4→5 migration adds a brand-new table). */
    private fun openV4(name: String): SupportSQLiteDatabase {
        context.deleteDatabase(name)
        val config = SupportSQLiteOpenHelper.Configuration.builder(context)
            .name(name)
            .callback(object : SupportSQLiteOpenHelper.Callback(4) {
                override fun onCreate(db: SupportSQLiteDatabase) {
                    db.execSQL("CREATE TABLE `placeholder` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL)")
                }
                override fun onUpgrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
            })
            .build()
        return FrameworkSQLiteOpenHelperFactory().create(config).writableDatabase
    }

    @Test
    fun `migration 4 to 5 adds the upcoming-payment cache table`() {
        val db = openV4("mig-test-4-5.db")
        DirectBankingDatabase.MIGRATION_4_5.migrate(db)

        db.execSQL("INSERT INTO upcoming_payment_cache VALUES ('m1','British Gas','Monzo','2026-08-15',8200,1000)")
        db.query("SELECT companyName, expectedAmountMinor FROM upcoming_payment_cache WHERE mandateId='m1'").use { c ->
            c.moveToFirst()
            assertEquals("British Gas", c.getString(0))
            assertEquals(8200, c.getInt(1))
        }
        db.close()
    }

    /** Opens a minimal v5 database (the 5→6 migration adds a brand-new table). */
    private fun openV5(name: String): SupportSQLiteDatabase {
        context.deleteDatabase(name)
        val config = SupportSQLiteOpenHelper.Configuration.builder(context)
            .name(name)
            .callback(object : SupportSQLiteOpenHelper.Callback(5) {
                override fun onCreate(db: SupportSQLiteDatabase) {
                    db.execSQL("CREATE TABLE `placeholder5` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL)")
                }
                override fun onUpgrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
            })
            .build()
        return FrameworkSQLiteOpenHelperFactory().create(config).writableDatabase
    }

    @Test
    fun `migration 5 to 6 adds the bank-connection cache table`() {
        val db = openV5("mig-test-5-6.db")
        DirectBankingDatabase.MIGRATION_5_6.migrate(db)
        db.execSQL("INSERT INTO bank_connection_cache VALUES ('c1','truelayer','ACTIVE','Monzo','2026-08-09T10:00:00',1000)")
        db.query("SELECT provider, status, institutionName FROM bank_connection_cache WHERE id='c1'").use { c ->
            c.moveToFirst()
            assertEquals("truelayer", c.getString(0))
            assertEquals("ACTIVE", c.getString(1))
            assertEquals("Monzo", c.getString(2))
        }
        db.close()
    }

    /** Opens a minimal v6 database (the 6→7 migration adds a brand-new table). */
    private fun openV6(name: String): SupportSQLiteDatabase {
        context.deleteDatabase(name)
        val config = SupportSQLiteOpenHelper.Configuration.builder(context)
            .name(name)
            .callback(object : SupportSQLiteOpenHelper.Callback(6) {
                override fun onCreate(db: SupportSQLiteDatabase) {
                    db.execSQL("CREATE TABLE `placeholder6` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL)")
                }
                override fun onUpgrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
            })
            .build()
        return FrameworkSQLiteOpenHelperFactory().create(config).writableDatabase
    }

    @Test
    fun `migration 6 to 7 adds the insights cache table`() {
        val db = openV6("mig-test-6-7.db")
        DirectBankingDatabase.MIGRATION_6_7.migrate(db)
        db.execSQL("INSERT INTO insights_cache VALUES ('overview','{\"safeToSpend\":{}}',1000)")
        db.query("SELECT json, cachedAtMillis FROM insights_cache WHERE `key`='overview'").use { c ->
            c.moveToFirst()
            assertEquals("{\"safeToSpend\":{}}", c.getString(0))
            assertEquals(1000, c.getInt(1))
        }
        db.close()
    }

    /**
     * Phase 6 §20: simulates upgrading an installation that has been sitting at
     * the very first Room schema (v1) — e.g. a user who installed long ago and
     * is now doing `adb install -r` straight to the current APK, never
     * uninstalling. Seeds real v1 data, then opens the SAME on-disk database
     * through Room's real migration runner (not by invoking each `Migration`
     * object by hand, unlike the pairwise tests above) with the full
     * `ALL_MIGRATIONS` list, exactly as `DirectBankingDatabase.build()` does in
     * production. Confirms the chain 1→2→3→4→5→6→7 runs end-to-end, old data
     * survives the whole journey, and the database is fully usable at v7
     * afterward (no destructive fallback is configured, so any migration gap
     * would throw here rather than silently wiping data).
     */
    @Test
    fun `full chain v1 to v7 upgrade preserves existing data and lands on a usable v7 database`() {
        val name = "mig-test-full-chain.db"
        // Seed a v1 database with the same shape a real early install would have.
        val v1 = openV1(name)
        v1.execSQL("INSERT INTO approved_source VALUES ('com.monzo.app', 'Monzo', 1, 100, 200)")
        v1.execSQL("INSERT INTO parsed_import VALUES ('fp-chain','com.monzo.app','EXPENSE',4599,'GBP','Tesco',NULL,1000,0.9,'DRAFT','txt','Tesco','LOCAL',NULL,500)")
        v1.close()

        // Open the same file through Room's real upgrade path.
        val db = Room.databaseBuilder(context, DirectBankingDatabase::class.java, name)
            .addMigrations(*DirectBankingDatabase.ALL_MIGRATIONS)
            .build()
        // Force Room to actually open (and therefore migrate) the database now.
        val opened = db.openHelper.writableDatabase
        assertEquals(7, opened.version)

        // Pre-v7 data survived the entire chain.
        opened.query("SELECT approved FROM approved_source WHERE packageName='com.monzo.app'").use { c ->
            assertTrue(c.moveToFirst())
            assertEquals(1, c.getInt(0))
        }
        opened.query("SELECT amountMinor FROM parsed_import WHERE fingerprint='fp-chain'").use { c ->
            assertTrue(c.moveToFirst())
            assertEquals(4599, c.getInt(0))
        }

        // The v7 table (added by the last migration in the chain) is present and usable.
        opened.execSQL("INSERT INTO insights_cache VALUES ('chain-check','{}',42)")
        opened.query("SELECT cachedAtMillis FROM insights_cache WHERE `key`='chain-check'").use { c ->
            assertTrue(c.moveToFirst())
            assertEquals(42, c.getInt(0))
        }
        db.close()
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

    @Test
    fun `migration 3 to 4 adds enrichment columns and preserves parsed drafts`() {
        val db = openV3("mig-test-3-4.db")
        db.execSQL(
            "INSERT INTO parsed_import VALUES " +
                "('fp1','com.bank','EXPENSE',1245,'GBP','Tesco',NULL,1000,0.95,'DRAFT','txt','Tesco','LOCAL',NULL,500)",
        )

        DirectBankingDatabase.MIGRATION_3_4.migrate(db)

        // Existing draft survives and gains the four nullable enrichment columns.
        db.query(
            "SELECT amountMinor, senderName, recipientName, paymentReference, paymentReason FROM parsed_import WHERE fingerprint='fp1'",
        ).use { c ->
            c.moveToFirst()
            assertEquals(1245, c.getInt(0)) // preserved
            assertEquals(true, c.isNull(1)) // enrichment null by default
            assertEquals(true, c.isNull(2))
            assertEquals(true, c.isNull(3))
            assertEquals(true, c.isNull(4))
        }

        // The new columns are writable and persist.
        db.execSQL("UPDATE parsed_import SET recipientName='Sardar Saeed', paymentReference='INV-9' WHERE fingerprint='fp1'")
        db.query("SELECT recipientName, paymentReference FROM parsed_import WHERE fingerprint='fp1'").use { c ->
            c.moveToFirst()
            assertEquals("Sardar Saeed", c.getString(0))
            assertEquals("INV-9", c.getString(1))
        }
        db.close()
    }
}
