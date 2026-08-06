package uk.co.prisom.directbanking.data.repository

import uk.co.prisom.directbanking.domain.AccountSummary
import uk.co.prisom.directbanking.domain.DashboardData
import uk.co.prisom.directbanking.domain.DashboardSummary
import uk.co.prisom.directbanking.domain.DirectDebitSummary

/** Reads the live dashboard from the existing backend bootstrap endpoint. */
class DashboardRepository(private val authRepository: AuthRepository) {

    suspend fun load(): DashboardData {
        val b = authRepository.bootstrap()
        return DashboardData(
            displayName = b.user?.displayName,
            baseCurrency = b.user?.baseCurrency ?: "GBP",
            summary = DashboardSummary(
                incomeMinor = b.dashboard.incomeMinor,
                expenseMinor = b.dashboard.expenseMinor,
                safeToSpendMinor = b.dashboard.safeToSpendMinor,
                totalBalanceMinor = b.dashboard.totalBalanceMinor,
                remainingDirectDebitsMinor = b.dashboard.remainingDirectDebitsMinor,
            ),
            accounts = b.accounts.map {
                AccountSummary(it.id, it.nickname, it.bankName, it.lastFour, it.currency, it.balanceMinor, it.colour)
            },
            directDebits = b.directDebits.map {
                DirectDebitSummary(it.id, it.merchantName, it.expectedAmountMinor, it.currency, it.nextDueDate)
            },
            pendingImports = b.pendingImports,
        )
    }
}
