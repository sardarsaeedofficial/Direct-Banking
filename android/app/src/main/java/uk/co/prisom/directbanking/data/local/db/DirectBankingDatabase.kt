package uk.co.prisom.directbanking.data.local.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [
        ParsedImportEntity::class,
        CapturedNotificationEntity::class,
        PendingSyncOpEntity::class,
        ApprovedSourceEntity::class,
        UpcomingPaymentEntity::class,
    ],
    version = 5,
    exportSchema = true,
)
abstract class DirectBankingDatabase : RoomDatabase() {
    abstract fun importDao(): ImportDao
    abstract fun capturedDao(): CapturedDao
    abstract fun syncDao(): SyncDao
    abstract fun sourceDao(): SourceDao
    abstract fun upcomingDao(): UpcomingDao

    companion object {
        /** v2 adds the user-controlled "permanently ignore" flag to approved_source. */
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `approved_source` ADD COLUMN `ignored` INTEGER NOT NULL DEFAULT 0")
            }
        }

        /** v3 adds automatic-import configuration columns to approved_source (additive). */
        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `approved_source` ADD COLUMN `autoImportEnabled` INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE `approved_source` ADD COLUMN `requireReview` INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE `approved_source` ADD COLUMN `defaultAccountId` TEXT")
                db.execSQL("ALTER TABLE `approved_source` ADD COLUMN `isBuiltInTrusted` INTEGER NOT NULL DEFAULT 0")
            }
        }

        /** v4 adds Phase 1 enrichment columns to parsed_import so counterparties,
         *  reference and reason survive the Review flow (additive). */
        val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `parsed_import` ADD COLUMN `senderName` TEXT")
                db.execSQL("ALTER TABLE `parsed_import` ADD COLUMN `recipientName` TEXT")
                db.execSQL("ALTER TABLE `parsed_import` ADD COLUMN `paymentReference` TEXT")
                db.execSQL("ALTER TABLE `parsed_import` ADD COLUMN `paymentReason` TEXT")
            }
        }

        /** v5 adds the Phase 2 offline cache of upcoming Direct Debit payments (additive). */
        val MIGRATION_4_5 = object : Migration(4, 5) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `upcoming_payment_cache` (`mandateId` TEXT NOT NULL, " +
                        "`companyName` TEXT NOT NULL, `account` TEXT NOT NULL, `expectedDate` TEXT, " +
                        "`expectedAmountMinor` INTEGER NOT NULL, `cachedAtMillis` INTEGER NOT NULL, PRIMARY KEY(`mandateId`))",
                )
            }
        }

        val ALL_MIGRATIONS = arrayOf(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5)

        fun build(context: Context): DirectBankingDatabase =
            Room.databaseBuilder(context, DirectBankingDatabase::class.java, "directbanking.db")
                // Explicit migrations only — never destroy user data in production.
                .addMigrations(*ALL_MIGRATIONS)
                .build()
    }
}
