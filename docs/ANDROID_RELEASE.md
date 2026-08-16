# Android release runbook

Builds and releases the Direct Banking Android app. This supersedes the
signing section of the older `docs/android-release-checklist.md` (still
useful for the Play Store readiness checklist) with the current, Phase 5/6
environment-based signing setup.

## 1. Pull the final commit

```bash
git fetch origin --prune
git checkout <release-branch-or-commit>
git log -1 --oneline
```

Confirm this is the commit you intend to release — check
`docs/PHASE6_AUDIT.md` (or the relevant phase report) for the identified
Release Candidate commit hash.

## 2. Configure the Android SDK

Requires:

- JDK 17
- Android SDK with the compile/target SDK version used by
  `android/app/build.gradle.kts` (check `compileSdk`/`targetSdk` there)
- `ANDROID_HOME`/`local.properties` pointing at the SDK (Android Studio sets
  this up automatically; for CI, set `sdk.dir` in `android/local.properties`
  or the `ANDROID_HOME` environment variable)

`android/local.properties` and `android/keystore.properties` are both
git-ignored — never commit either.

## 3. Run unit tests

```bash
cd android
./gradlew testDebugUnitTest
```

Includes the Room migration test suite (`RoomMigrationTest`), which exercises
every individual schema migration plus a full end-to-end v1→v7 upgrade chain
through Room's real migration runner — see `docs/PHASE6_AUDIT.md` §9.

## 4. Run lint

```bash
./gradlew lintDebug
./gradlew lintRelease
```

Both must report `BUILD SUCCESSFUL`. Review
`app/build/reports/lint-results-*.html` for anything new before releasing.

## 5. Build the debug APK

```bash
./gradlew assembleDebug
```

Output: `app/build/outputs/apk/debug/app-debug.apk`. Useful for local
`adb install -r` testing (see step 10) before cutting a signed release.

## 6. Configure release signing

Release signing reads from **environment variables first, then
`keystore.properties`** (`android/app/build.gradle.kts`):

```
DIRECT_BANKING_KEYSTORE_PATH       # absolute path to the .jks/.keystore file
DIRECT_BANKING_KEYSTORE_PASSWORD
DIRECT_BANKING_KEY_ALIAS
DIRECT_BANKING_KEY_PASSWORD
```

**Never commit a real keystore or these values.** `android/keystore.properties`
is git-ignored for exactly this reason.

### Creating a release keystore (once, outside the repo)

```bash
keytool -genkeypair -v -keystore /secure/path/directbanking-upload.jks \
  -keyalg RSA -keysize 2048 -validity 10000 -alias upload
```

Store the resulting file and its passwords in a password manager / secrets
vault — **losing a self-managed upload key permanently prevents future
updates to an already-published app.** Back it up before you need it.

### Configuring it locally (either mechanism works)

**Environment variables** (CI-friendly):

```bash
export DIRECT_BANKING_KEYSTORE_PATH=/secure/path/directbanking-upload.jks
export DIRECT_BANKING_KEYSTORE_PASSWORD='...'
export DIRECT_BANKING_KEY_ALIAS=upload
export DIRECT_BANKING_KEY_PASSWORD='...'
```

**Or** `android/keystore.properties` (local-dev-friendly, git-ignored):

```properties
storeFile=/secure/path/directbanking-upload.jks
storePassword=...
keyAlias=upload
keyPassword=...
```

**Never print these values** — don't `echo` them, don't include them in CI
log output, don't paste them into a chat or issue tracker.

### Behaviour with and without credentials

- **Without either mechanism configured**: `assembleDebug` still succeeds
  (debug is never signing-gated); `assembleRelease` succeeds and produces an
  **unsigned** `app-release-unsigned.apk` — the build does not fail, but the
  artifact can't be installed directly or uploaded to Play until signed
  separately (e.g. via Play App Signing's upload-key flow, or by signing the
  artifact after the fact).
- **With valid credentials configured**: `assembleRelease` produces a
  **signed** `app-release.apk`, and `bundleRelease` produces a signed
  `app-release.aab`.

## 7. Build the release APK

```bash
./gradlew assembleRelease
```

Output: `app/build/outputs/apk/release/app-release{,-unsigned}.apk` (signed
or unsigned depending on step 6).

## 8. Build the release bundle (Play upload format)

```bash
./gradlew bundleRelease
```

Output: `app/build/outputs/bundle/release/app-release.aab`.

## 9. Verify the artifact

```bash
# Confirms whether the APK is actually signed and with what certificate.
apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk

# Sanity-check the versionCode/versionName actually baked into the artifact.
aapt dump badging app/build/outputs/apk/release/app-release.apk | grep versionCode
```

Cross-check the reported `versionCode` against what you expect to ship — see
`docs/PHASE6_AUDIT.md` §10 for the versioning policy (increment `versionCode`
for every release **after** the first one that's actually distributed).

## 10. `adb install -r` for upgrade testing

To verify an in-place upgrade over an existing install (Room migration, session
survival, cached data) rather than a clean install:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk   # or the release APK
```

`-r` reinstalls **without uninstalling first**, so Room runs its real
migration path against the existing on-device database — this is the
literal, physical-device equivalent of the migration proof described in
`docs/PHASE6_AUDIT.md` §9. After installing, confirm: the user is still
logged in, Settings/preferences are unchanged, previously captured
notifications/source approvals are still present, and cached Home/Insights
data is still visible before the app reaches the network.

Do **not** run `adb install -r` as part of an automated pipeline against a
device you don't control — it's a manual verification step.

## Do not

- Commit a keystore, `keystore.properties`, `local.properties`, or any built
  `.apk`/`.aab` (all git-ignored already).
- Print signing passwords in logs, chat, or commit messages.
- Push, deploy, or install an APK as a side effect of running the build gates
  — building and installing are separate, explicit actions.
