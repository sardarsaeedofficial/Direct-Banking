package uk.co.prisom.directbanking.data.local.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [
        ParsedImportEntity::class,
        CapturedNotificationEntity::class,
        PendingSyncOpEntity::class,
        ApprovedSourceEntity::class,
    ],
    version = 1,
    exportSchema = false,
)
abstract class DirectBankingDatabase : RoomDatabase() {
    abstract fun importDao(): ImportDao
    abstract fun capturedDao(): CapturedDao
    abstract fun syncDao(): SyncDao
    abstract fun sourceDao(): SourceDao

    companion object {
        fun build(context: Context): DirectBankingDatabase =
            Room.databaseBuilder(context, DirectBankingDatabase::class.java, "directbanking.db")
                .fallbackToDestructiveMigration()
                .build()
    }
}
