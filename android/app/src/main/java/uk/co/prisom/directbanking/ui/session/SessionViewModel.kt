package uk.co.prisom.directbanking.ui.session

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import retrofit2.HttpException
import uk.co.prisom.directbanking.data.remote.dto.UserDto
import uk.co.prisom.directbanking.data.repository.AuthRepository
import java.io.IOException

sealed interface SessionState {
    data object Loading : SessionState
    data object SignedOut : SessionState
    data class SignedIn(val user: UserDto) : SessionState
}

sealed interface FormState {
    data object Idle : FormState
    data object Submitting : FormState
    data class Error(val message: String) : FormState
}

/** Owns session restoration, sign-in/registration, logout and forced sign-out. */
class SessionViewModel(private val auth: AuthRepository) : ViewModel() {

    private val _state = MutableStateFlow<SessionState>(SessionState.Loading)
    val state = _state.asStateFlow()

    private val _form = MutableStateFlow<FormState>(FormState.Idle)
    val form = _form.asStateFlow()

    init { restore() }

    /** Restore the session: validate the stored token (refreshing if needed). */
    fun restore() {
        viewModelScope.launch {
            if (!auth.isLoggedIn()) {
                _state.value = SessionState.SignedOut
                return@launch
            }
            _state.value = try {
                SessionState.SignedIn(auth.me())
            } catch (t: Throwable) {
                // me() failed; if refresh also failed the token store was cleared.
                SessionState.SignedOut
            }
        }
    }

    fun signIn(email: String, password: String, totp: String?) = submit { auth.login(email, password, totp) }
    fun register(email: String, password: String, displayName: String?) = submit { auth.register(email, password, displayName) }

    fun logout(allDevices: Boolean = false) {
        viewModelScope.launch {
            auth.logout(allDevices)
            _state.value = SessionState.SignedOut
        }
    }

    /**
     * Final release completion (§3): after account deletion, credentials and
     * local Room data are already cleared (SettingsViewModel.deleteAccount) —
     * calling the ordinary server logout endpoint here would be pointless
     * (the account, and so the session, no longer exists) and would only
     * produce a confusing 401. This just reflects the already-true state so
     * the UI returns to login/onboarding.
     */
    fun signOutAfterAccountDeletion() {
        _state.value = SessionState.SignedOut
    }

    fun clearError() { if (_form.value is FormState.Error) _form.value = FormState.Idle }

    private fun submit(block: suspend () -> Result<UserDto>) {
        viewModelScope.launch {
            _form.value = FormState.Submitting
            block()
                .onSuccess { _state.value = SessionState.SignedIn(it); _form.value = FormState.Idle }
                .onFailure { _form.value = FormState.Error(serverMessage(it)) }
        }
    }

    private fun serverMessage(t: Throwable): String = when (t) {
        is HttpException -> {
            val body = runCatching { t.response()?.errorBody()?.string() }.getOrNull()
            val parsed = body?.let {
                runCatching { Json.parseToJsonElement(it).jsonObject["error"]?.jsonPrimitive?.content }.getOrNull()
            }
            parsed ?: "Request failed (${t.code()})"
        }
        is IOException -> "No connection. Check your internet and try again."
        else -> "Something went wrong. Please try again."
    }
}
