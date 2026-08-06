# Android release checklist

## Backend prerequisites (deploy before shipping the app)

The app depends on the mobile API and the mobile-auth tables.

1. Apply the Prisma migration **`20260804220338_mobile_auth_and_imports`** in
   production (additive: `MobileDevice`, `MobileRefreshToken`, extra
   `NotificationImport` columns). Review it, then:
   ```bash
   pnpm exec prisma migrate deploy
   ```
2. Set backend environment variables:
   - `MOBILE_JWT_SECRET` — **required in production**, ≥16 chars, secret & unique.
   - `MOBILE_ACCESS_TTL_MIN` (default 15) · `MOBILE_REFRESH_TTL_DAYS` (default 30).
3. Redeploy the Direct Banking backend so `/api/mobile/v1/*` is live.

## Signing (keys never committed)

Create a keystore **outside** the repo and back it up securely — losing a
self-managed upload key prevents future updates:

```bash
keytool -genkeypair -v -keystore directbanking-upload.jks \
  -keyalg RSA -keysize 2048 -validity 10000 -alias upload
```

Create `android/keystore.properties` (git-ignored):

```properties
storeFile=/absolute/path/to/directbanking-upload.jks
storePassword=…
keyAlias=upload
keyPassword=…
```

`app/build.gradle.kts` reads this and applies the `release` signing config only
when the file is present. Without it, release artifacts build **unsigned**.

## Build artifacts

```bash
cd android
./gradlew testReleaseUnitTest   # optional
./gradlew assembleRelease        # -> app/build/outputs/apk/release/app-release.apk (direct install)
./gradlew bundleRelease          # -> app/build/outputs/bundle/release/app-release.aab (Play upload)
```

- APKs must be signed to install directly.
- Play distribution uses an upload key + Play App Signing.
- Debug-only tooling (notification simulator) is excluded from release builds.

## Store readiness

- [ ] Privacy policy published and linked in-app (Settings → Privacy policy).
- [ ] Data safety form: notification content is used to create user transactions,
      stored encrypted in transit, not sold, not shared with third parties.
- [ ] Notification-access (special app access) usage justified in the listing and
      gated behind the in-app disclosure + affirmative consent.
- [ ] `POST_NOTIFICATIONS` requested only for the app's own reminders.
- [ ] Account/data deletion available in-app and documented.
- [ ] No ad SDKs; no notification content in analytics/Crashlytics.

## Do not

- Commit signing keys, `keystore.properties`, `local.properties`, or built
  `.apk`/`.aab` files (all git-ignored).
- Push, deploy, or apply the production migration as part of the build — these are
  explicit, reviewed operations.
