package uk.co.prisom.directbanking.di

import android.content.Context
import kotlinx.coroutines.flow.first
import uk.co.prisom.directbanking.BuildConfig
import uk.co.prisom.directbanking.data.AndroidSignatureInspector
import uk.co.prisom.directbanking.data.DiagnosticsRepository
import uk.co.prisom.directbanking.data.TrustedSources
import uk.co.prisom.directbanking.data.local.AppPreferences
import uk.co.prisom.directbanking.data.local.db.DirectBankingDatabase
import uk.co.prisom.directbanking.data.local.security.SecureTokenStore
import uk.co.prisom.directbanking.data.local.security.TokenStore
import uk.co.prisom.directbanking.data.remote.ApiFactory
import uk.co.prisom.directbanking.notifications.AppNotifier
import uk.co.prisom.directbanking.data.repository.AuthRepository
import uk.co.prisom.directbanking.data.repository.AutoImportResult
import uk.co.prisom.directbanking.data.repository.BankConnectionRepository
import uk.co.prisom.directbanking.data.repository.DashboardRepository
import uk.co.prisom.directbanking.data.repository.DirectDebitRepository
import uk.co.prisom.directbanking.data.repository.ImportRepository
import uk.co.prisom.directbanking.data.repository.SourceRepository
import uk.co.prisom.directbanking.data.repository.SyncRepository
import uk.co.prisom.directbanking.data.repository.TransactionRepository
import uk.co.prisom.directbanking.parsing.ParserRegistry

/** Manual dependency graph (no DI framework needed for this app size). */
class AppContainer(context: Context) {
    val appContext: Context = context.applicationContext

    val tokenStore: TokenStore = SecureTokenStore(appContext)
    val appPreferences = AppPreferences(appContext)
    val notifier = AppNotifier(appContext)
    val diagnostics = DiagnosticsRepository()
    private val json = ApiFactory.json
    private val apiClients = ApiFactory.create(BuildConfig.API_BASE_URL, tokenStore, BuildConfig.DEBUG)
    val db = DirectBankingDatabase.build(appContext)
    private val signatureInspector = AndroidSignatureInspector(appContext)

    val authRepository = AuthRepository(apiClients, tokenStore, BuildConfig.VERSION_NAME)
    val dashboardRepository = DashboardRepository(authRepository)
    val transactionRepository = TransactionRepository(apiClients)
    val directDebitRepository = DirectDebitRepository(apiClients, db.upcomingDao())
    val bankConnectionRepository = BankConnectionRepository(apiClients, db.bankConnectionDao())
    val sourceRepository = SourceRepository(db.sourceDao())
    val importRepository = ImportRepository(
        db.importDao(), db.syncDao(), db.sourceDao(), db.capturedDao(), tokenStore, ParserRegistry(), json,
        autoImport = { req ->
            try {
                val res = apiClients.authApi.autoImport(req)
                if (res.result == "DUPLICATE") AutoImportResult.Duplicate(res.transaction?.id)
                else AutoImportResult.Imported(res.transaction?.id ?: "", res.import.id)
            } catch (_: Throwable) {
                AutoImportResult.Failed
            }
        },
        disclosureAccepted = { appPreferences.disclosureAccepted.first() },
        resolveTrust = { pkg, approved -> TrustedSources.resolveTrust(signatureInspector, pkg, approved) },
    )
    val syncRepository = SyncRepository(
        apiClients.authApi, db.importDao(), db.syncDao(), json,
        onAutoImported = { amountMinor, currency, direction, sourceName, txnId ->
            notifier.postRecorded(amountMinor, currency, direction, sourceName, txnId)
        },
    )
}
