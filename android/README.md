# Direct Banking — Android app

Native Android client for Direct Banking. It reads transaction notifications from
banking apps the user explicitly approves, turns them into **draft** transactions
for review, and — only after approval — creates real transactions through the
existing Direct Banking backend so the web and Android dashboards stay consistent.

- **Application id:** `uk.co.prisom.directbanking`
- **minSdk** 26 · **compileSdk / targetSdk** 36
- **Stack:** Kotlin, Jetpack Compose + Material 3, MVVM, Retrofit/OkHttp, Kotlin
  coroutines, Room, WorkManager, Android Keystore (EncryptedSharedPreferences),
  kotlinx.serialization. Versions are pinned in `gradle/libs.versions.toml`.

## Build

Requires JDK 17 and an Android SDK with platform **android-36** installed. Point
Gradle at the SDK via `android/local.properties` (not committed):

```properties
sdk.dir=/absolute/path/to/Android/Sdk
```

```bash
cd android
./gradlew test          # unit tests (parser, repositories, auth, sync, ViewModels)
./gradlew lint          # Android lint
./gradlew assembleDebug # -> app/build/outputs/apk/debug/app-debug.apk
```

The debug APK targets the deployed API at
`https://direct-banking.doorstepmanchester.uk/` (see `BuildConfig.API_BASE_URL`).
No secrets are embedded in the APK.

## Architecture

```
notifications/  BankNotificationListenerService (system-bound) → CaptureCoordinator
parsing/        Money, Redaction, Fingerprint, ParserRegistry (+ bank adapters),
                SourceFilter (always-ignore self/system/messaging/email/OTP)
data/remote/    Retrofit MobileApi, DTOs, AuthInterceptor, TokenAuthenticator,
                SessionRefresher (single-flight refresh)
data/local/     Room (ParsedImport, CapturedNotification, PendingSyncOperation,
                ApprovedNotificationSource), SecureTokenStore (Keystore), AppPreferences
data/repository Auth, Dashboard, Transaction, Source, Import, Sync repositories
sync/           WorkManager SyncWorker (network-constrained, idempotent, retrying)
ui/             Compose screens + ViewModels + navigation, manual DI (AppContainer)
di/             AppContainer (manual dependency graph)
```

The capture callback does **no** parsing, DB or network work on the callback
thread — it hands the minimal extracted extras to a background coroutine
(`CaptureCoordinator`). See [../docs/android-notification-import.md](../docs/android-notification-import.md).

## Privacy & security

- HTTPS only; cleartext traffic disabled (`network_security_config.xml`).
- Refresh token stored in Android Keystore-backed EncryptedSharedPreferences.
- No notification text in logs (release), Crashlytics or analytics; no ad SDKs.
- Nothing is parsed or stored before the user accepts the disclosure **and**
  approves the specific source. Unapproved sources are recorded as package
  metadata only.
- Account numbers are redacted except the final four digits; PINs/OTPs/full card
  numbers are never collected.
- In-app disclosure, per-source enable/disable/ignore, and data deletion are
  provided under Settings & privacy.

## Debug simulator

Debug builds include a **notification simulator** (Settings → "Debug: notification
simulator") that drives the *real* pipeline (listener sink → filter → parser →
Room → WorkManager → review) for representative scenarios. It lives in the
`debug` source set and is absent from release builds (`release` provides a stub).

## Release

See [../docs/android-release-checklist.md](../docs/android-release-checklist.md).
Signing keys and `keystore.properties` are never committed.
