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
    ],
    version = 3,
    exportSchema = true,
)
abstract class DirectBankingDatabase : RoomDatabase() {
    abstract fun importDao(): ImportDao
    abstract fun capturedDao(): CapturedDao
    abstract fun syncDao(): SyncDao
    abstract fun sourceDao(): SourceDao

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

        val ALL_MIGRATIONS = arrayOf(MIGRATION_1_2, MIGRATION_2_3)

        fun build(context: Context): DirectBankingDatabase =
            Room.databaseBuilder(context, DirectBankingDatabase::class.java, "directbanking.db")
                // Explicit migrations only — never destroy user data in production.
                .addMigrations(*ALL_MIGRATIONS)
                .build()
    }
}
