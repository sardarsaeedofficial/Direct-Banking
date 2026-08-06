# Android notification import

How the Android app turns bank notifications into reviewed Direct Banking
transactions, and the privacy rules that govern it.

## Consent-gated pipeline

```
BankNotificationListenerService.onNotificationPosted   (main thread — minimal work)
  → extract only: EXTRA_TITLE, EXTRA_TEXT, EXTRA_BIG_TEXT, EXTRA_TEXT_LINES,
    EXTRA_SUB_TEXT, packageName, postTime, key, category
  → hand off to a background coroutine (CaptureCoordinator)   [no DB/net/parse on callback]

CaptureCoordinator / ImportRepository.capture:
  → SourceFilter.passesBaseline?   (always ignore Direct Banking, Android system,
                                     messaging, email, OTP/auth)     → drop
  → source permanently ignored?                                      → drop
  → record observed source (label + package ONLY, never text)
  → source approved by user?                                         → if not, stop here
  → ParserRegistry.parse → ParsedTransactionCandidate
  → duplicate Fingerprint (userId, deviceId, package, amount, direction,
    normalised merchant, 2-min time bucket)
  → store ParsedImport in Room (redacted text only)
  → confidence ≥ 0.60 → enqueue idempotent CREATE upload + schedule WorkManager sync
  → post a "needs review" notification (if POST_NOTIFICATIONS granted)
```

**Nothing is parsed or stored before** (a) the user accepts the in-app disclosure
and (b) approves that specific source. Notifications from unapproved apps only ever
contribute an app label + package name so the user can choose to approve them.

## Confidence → review state

| Confidence | State | Behaviour |
|-----------:|-------|-----------|
| ≥ 0.90 | `DRAFT` | draft created + user notified |
| 0.60–0.89 | `REVIEW_REQUIRED` | draft created, marked review-required |
| < 0.60 | `UNRECOGNISED` | kept locally, **not** auto-synced |

Deterministic package adapters (Monzo, Starling, Revolut, …) are tried before the
generic parser and yield higher confidence.

## Review before import

Detected items appear under **Review imports**. The user can edit amount,
direction (debit/credit), merchant, date/time, account, category and notes, then
**Approve**, **Reject**, or **Ignore source**. Approval calls the existing
notification-import approval flow, which creates the transaction through the shared
backend transaction service — the same records the web dashboard uses.

## Idempotency & offline

Every upload is idempotent: the server enforces uniqueness on the per-user
fingerprint (stored as `sourceHash`), so a reposted/updated notification never
creates a duplicate. `APPROVE` treats HTTP 409 as success; `DELETE` treats 404 as
success. Queued operations are drained by a network-constrained WorkManager worker
that retries with backoff; offline captures sync when connectivity returns.

## Data minimisation

- Only the notification extras listed above are read.
- Raw text is redacted immediately (account/card numbers masked except last four).
- Full notification text is never written to logs in release builds and is not
  sent to analytics/Crashlytics.
- Deleting captured local data (Settings) clears the Room queue.

## Backend surface used

- `POST /api/mobile/v1/auth/{register,login,refresh,logout}`
- `GET  /api/mobile/v1/{me,bootstrap,transactions}`
- `POST/GET/PATCH/DELETE /api/mobile/v1/notification-imports`

Mobile auth uses short-lived JWT access tokens + rotating refresh tokens hashed in
PostgreSQL (device sessions, reuse-detection revocation). The refresh token is held
in Android Keystore-backed storage.
