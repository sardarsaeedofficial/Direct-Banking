package uk.co.prisom.directbanking.di

import android.content.Context
import uk.co.prisom.directbanking.BuildConfig
import uk.co.prisom.directbanking.data.local.db.DirectBankingDatabase
import uk.co.prisom.directbanking.data.local.security.SecureTokenStore
import uk.co.prisom.directbanking.data.local.security.TokenStore
import uk.co.prisom.directbanking.data.remote.ApiFactory
import uk.co.prisom.directbanking.data.repository.AuthRepository
import uk.co.prisom.directbanking.data.repository.DashboardRepository
import uk.co.prisom.directbanking.data.repository.ImportRepository
import uk.co.prisom.directbanking.data.repository.SourceRepository
import uk.co.prisom.directbanking.data.repository.SyncRepository
import uk.co.prisom.directbanking.data.repository.TransactionRepository
import uk.co.prisom.directbanking.parsing.ParserRegistry

/** Manual dependency graph (no DI framework needed for this app size). */
class AppContainer(context: Context) {
    private val appContext = context.applicationContext

    val tokenStore: TokenStore = SecureTokenStore(appContext)
    private val json = ApiFactory.json
    private val apiClients = ApiFactory.create(BuildConfig.API_BASE_URL, tokenStore, BuildConfig.DEBUG)
    private val db = DirectBankingDatabase.build(appContext)

    val authRepository = AuthRepository(apiClients, tokenStore, BuildConfig.VERSION_NAME)
    val dashboardRepository = DashboardRepository(authRepository)
    val transactionRepository = TransactionRepository(apiClients)
    val sourceRepository = SourceRepository(db.sourceDao())
    val importRepository = ImportRepository(db.importDao(), db.syncDao(), db.sourceDao(), tokenStore, ParserRegistry(), json)
    val syncRepository = SyncRepository(apiClients.authApi, db.importDao(), db.syncDao(), json)
}
