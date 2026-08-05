package uk.co.prisom.directbanking.data.remote.dto

import kotlinx.serialization.Serializable

@Serializable
data class DeviceInfoDto(
    val deviceId: String,
    val model: String? = null,
    val appVersion: String? = null,
    val platform: String = "android",
)

@Serializable
data class LoginRequest(
    val email: String,
    val password: String,
    val totp: String? = null,
    val device: DeviceInfoDto,
)

@Serializable data class RefreshRequest(val refreshToken: String)
@Serializable data class LogoutRequest(val allDevices: Boolean = false)

@Serializable
data class UserDto(
    val id: String,
    val email: String,
    val displayName: String? = null,
    val baseCurrency: String = "GBP",
    val locale: String = "en-GB",
    val twoFactorEnabled: Boolean = false,
)

@Serializable
data class LoginResponse(
    val user: UserDto? = null,
    val accessToken: String,
    val refreshToken: String,
    val expiresIn: Long,
)

@Serializable data class TokenResponse(val accessToken: String, val refreshToken: String, val expiresIn: Long)
@Serializable data class MeResponse(val user: UserDto)

@Serializable
data class AccountDto(
    val id: String,
    val nickname: String = "",
    val bankName: String = "",
    val lastFour: String? = null,
    val currency: String = "GBP",
    val balanceMinor: Long = 0,
    val accountType: String = "CURRENT",
    val colour: String = "#2563eb",
    val icon: String? = null,
)

@Serializable data class CategoryDto(val id: String, val name: String, val colour: String? = null, val icon: String? = null)

@Serializable
data class DirectDebitDto(
    val id: String,
    val merchantName: String = "",
    val expectedAmountMinor: Long = 0,
    val currency: String = "GBP",
    val nextDueDate: String? = null,
    val frequency: String? = null,
)

@Serializable
data class DashboardDto(
    val incomeMinor: Long = 0,
    val expenseMinor: Long = 0,
    val safeToSpendMinor: Long = 0,
    val totalBalanceMinor: Long = 0,
    val remainingDirectDebitsMinor: Long = 0,
)

@Serializable
data class BootstrapResponse(
    val user: UserDto? = null,
    val accounts: List<AccountDto> = emptyList(),
    val categories: List<CategoryDto> = emptyList(),
    val directDebits: List<DirectDebitDto> = emptyList(),
    val dashboard: DashboardDto = DashboardDto(),
    val pendingImports: Int = 0,
    val serverTime: String? = null,
)

@Serializable
data class NotifImportRequest(
    val fingerprint: String,
    val sourcePackage: String,
    val direction: String,
    val amountMinor: Long,
    val currency: String,
    val merchant: String? = null,
    val accountHint: String? = null,
    val occurredAt: String,
    val confidence: Double,
    val redactedSourceText: String = "",
    val title: String = "",
)

@Serializable
data class NotifImportDto(
    val id: String,
    val sourcePackage: String = "",
    val title: String = "",
    val parsedMerchant: String? = null,
    val parsedAmountMinor: Long? = null,
    val parsedAccount: String? = null,
    val direction: String? = null,
    val currency: String = "GBP",
    val confidence: Double = 0.0,
    val reviewState: String = "DRAFT",
    val status: String = "PENDING",
    val receivedAt: String? = null,
    val redactedText: String? = null,
    val approvedTransactionId: String? = null,
)

@Serializable data class NotifImportCreateResponse(val import: NotifImportDto, val duplicate: Boolean = false)
@Serializable data class NotifImportListResponse(val items: List<NotifImportDto> = emptyList())

@Serializable
data class NotifImportPatchRequest(
    val action: String,
    val amountMinor: Long? = null,
    val direction: String? = null,
    val merchant: String? = null,
    val occurredAt: String? = null,
    val accountId: String? = null,
    val categoryId: String? = null,
    val notes: String? = null,
)

@Serializable data class TransactionDto(val id: String, val amountMinor: Long? = null, val direction: String? = null)
@Serializable data class NotifImportPatchResponse(val import: NotifImportDto, val transaction: TransactionDto? = null)
@Serializable data class DeletedResponse(val deleted: Boolean = false)
