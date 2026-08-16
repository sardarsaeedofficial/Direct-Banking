# Phase 6 — System & Financial Integrity Audit

Scope: review of every Phase 1–5 code path that creates a canonical `Transaction`
or mutates `BankAccount.balanceMinor`, plus the invariants in the Phase 6 brief.
This is a documentation of findings — fixes applied are noted per item, and the
corresponding regression tests live in `packages/server/src/services/phase6.test.ts`.

## 1. Canonical ledger — confirmed single write path

Every transaction-creating flow (manual entry, refund, notification approve —
both web and mobile, auto-import from a trusted source, CSV import, statement
import, Open Banking reconciliation, Direct Debit history) calls the single
`createTransaction()` in `transactions.service.ts`. There is no second,
independent "write a Transaction row and move a balance" implementation.

The only other `prisma.transaction.create` call site is the **split-transaction**
feature (`transactionsRouter.post("/:id/split")`): it creates non-balance-bearing
child rows (`parentId` set) that decompose an already-recorded parent into
categorised parts. Split children are excluded from every balance/aggregation
query via `parentId: null` filters throughout the codebase. This is an
intentional, correctly-scoped secondary write path, not a competing ledger.

## 2. Findings and fixes

### 2.1 FIXED — `createTransaction()` trusted the caller's `applyBalance` flag
instead of enforcing `balanceAuthority` itself

Only the Open Banking reconciliation service and the Phase 5 statement-import
service explicitly computed `applyBalance = account.balanceAuthority !== "PROVIDER"`
before calling `createTransaction()`. Three other call sites — **manual
transaction creation** (web `POST /transactions`), **notification approval**
(both web and mobile), and the **legacy CSV importer** (`csv-import.service.ts`)
— never checked `balanceAuthority` at all, so a provider-authoritative account's
`balanceMinor` could be pushed out of sync by any of these paths (transiently
corrected on the next Open Banking sync, but wrong until then; permanently wrong
for a bulk historical CSV import into a provider account if a sync never runs).

**Fix**: `createTransaction()` now looks up the target account's
`balanceAuthority` itself and refuses to apply the balance effect — regardless
of what the caller passed — when the account is `PROVIDER`-authoritative. The
same check was added for a transfer's counterparty account, and mirrored in
`reverseTransactionBalance()` for symmetry on edit/delete. The guarantee is now
structural (enforced once, in the ledger primitive) rather than dependent on
every caller remembering to opt out.

Covered by `phase6.test.ts` — "manual/notification/CSV-import creation never
moves a PROVIDER-authoritative balance".

### 2.2 FIXED — web notification-approval skipped the classification pipeline

`notification-import.service.ts`'s `approveNotification()` (used by the web
app's `POST /notifications/:id/approve`) created the transaction but never ran
`detectAndPairInternalTransfer()` / `detectDirectDebit()` afterward — unlike the
mobile app's equivalent approve flow in `mobile.routes.ts`, which already does.
A genuine internal transfer approved from the web UI would have stayed classified
as ordinary income + spending instead of being paired and excluded.

**Fix**: `approveNotification()` now runs the same classification pipeline as
the mobile flow (transfer detection first; Direct Debit detection only if the
transaction wasn't paired as a transfer).

Covered by `phase6.test.ts` — "web notification approval classifies an internal
transfer and excludes it from spend".

### 2.3 FIXED — legacy web CSV/report export lacked formula-injection protection

`reports.service.ts`'s `csvCell()` (used by `GET /reports/transactions.csv` and
the monthly/yearly grouped reports) only escaped quotes/commas/newlines. It did
not neutralise a cell beginning with `= + - @`, unlike Phase 5's
`export.service.ts`, which does. Transaction descriptions/merchant names can
originate from bank notification text or an imported statement, so this was a
real spreadsheet-formula-injection vector on export.

**Fix**: `csvCell()` now applies the same leading-apostrophe neutralisation as
the Phase 5 exporter before quote-escaping.

Covered by `phase6.test.ts` — "reports CSV export neutralises formula-injection
cells".

## 3. Findings documented, not changed (out of scope for a hardening phase)

These are real duplications/inconsistencies between the **legacy web dashboard**
(pre-dates Phase 1) and the **Phase 4+ mobile insights engine**, which is the
canonical, tested analytics surface. Consolidating them would change web-app UI
behaviour with no dedicated web-dashboard test coverage to validate safety, so
per the brief ("remove/change only when tests prove it safe", "do not redesign
the application") they are left as-is and documented here for a future,
dedicated pass:

- **`dashboard.service.ts` (web) vs `insights.service.ts` + `cashflow.service.ts`
  (mobile)** — two independent implementations of monthly income/spending and
  "safe to spend". Both correctly exclude `INTERNAL_TRANSFER` and non-completed
  statuses from income/spending (verified), so this is not a financial-integrity
  bug — the numbers just aren't guaranteed to match pixel-for-pixel between the
  web dashboard and the mobile app, because they're computed by different code.
- **`forecast.service.ts`'s `getBalances()` (web) silently sums `balanceMinor`
  across all of a user's accounts regardless of currency** — a real violation of
  "never silently combine GBP+EUR+USD" if a user holds multi-currency accounts,
  but confined to the legacy web dashboard's total-balance widget. The mobile
  `netWorth()` (Phase 4, `insights.service.ts`) already groups strictly by
  currency and does not have this issue.
- **`recurring-detection.service.ts` (web, `detectAnomalies`/`suggestRecurring`)
  vs `recurring.service.ts` (mobile, `detectSubscriptions`)** — two different
  algorithms for two different purposes (an "unusual spending" alert widget on
  the web dashboard vs. the subscription-confidence engine used by mobile
  Insights/Payments and the Review Centre). Both are read-only (no ledger
  writes), so there is no financial-integrity risk. Not deleted: `detectAnomalies`
  is still live on the web dashboard.
- **Web `budgets.routes.ts` GET** computes a simple spent-this-period aggregate
  directly for display, separate from the mobile `budgetProgress()` engine
  (which additionally tracks alert thresholds/status). Read-only, no integrity
  risk.

None of the above affects the mobile app, the Android client, or any of the
Phase 1–5 automated test coverage — all of that exercises the canonical
`createTransaction()` / mobile insights path exclusively.

## 4. Invariants re-verified against the canonical ledger

Confirmed by code review and exercised by `phase6.test.ts` (new) plus the
existing 154 Phase 1–5 tests:

| Invariant | Where enforced |
|---|---|
| A canonical transaction is created once | Single `createTransaction()`; provider `providerTransactionId` uniqueness + statement `(statementImportId, rowFingerprint)` uniqueness make retries idempotent |
| Balance is never updated twice | `balanceApplied` flag gates every reversal; `applyBalance` computed once per creation |
| PROVIDER balance immune to historical import | §2.1 fix, structural in `createTransaction()` |
| Internal transfers excluded from income/spend/budget/merchant/savings | `transactionType === "INTERNAL_TRANSFER"` filtered in `insights.service.ts`, `budgets.service.ts`, `merchant-intelligence.service.ts` |
| Cancelled/reversed excluded from spending | `status: { not: "CANCELLED" }` / `{ in: ["COMPLETED","PENDING"] }` filters throughout |
| Notification + Plaid + statement converge to one transaction | `reconcileProviderTransaction()` (Open Banking) and `reconcileStatement()`/`importStatement()` (Phase 5) both match-then-enrich before ever creating a new row |
| Pending → settled creates no duplicate | `reconcileProviderTransaction()`'s `pendingTransactionId` migration path |
| Manual corrections never double-apply balance | `transactionsRouter.put` gates re-apply on `existing.balanceApplied`; `TransactionCorrection` audit never itself touches balance |

## 5. Database integrity audit

Reviewed the complete schema and all 9 migrations (`init` through
`statement_import_review`) for foreign keys, unique constraints, indexes, and
orphan risk on every model named in the brief.

**Confirmed correct, no change needed:**
- Every user-owned model has a `userId` FK with `onDelete: Cascade` from `User`,
  and an index (bare or composite) covering ownership lookups.
- Transaction-lookup indexes cover the query shapes actually used:
  `[userId, bookedAt]`, `[accountId, bookedAt]`, `[merchantId]`,
  `[userId, dedupeHash]`, `[directDebitMandateId]`,
  `[userId, internalTransferGroupId]`, `[userId, transactionType]`,
  `[userId, categoryId, bookedAt]`, `[userId, merchantId, bookedAt]`.
- Statement/reconciliation indexes: `StatementImport` on `userId` and
  `[userId, accountId]`; `StatementCandidate` on `statementImportId` and
  `[statementImportId, fingerprint]`; `TransactionEvidence` on
  `statementImportId`; `ReconciliationDecision`'s unique
  `[userId, transactionAId, transactionBId]` also serves as its lookup index.
- Cascade design intentionally avoids orphan/cascade-conflict chains:
  `BankAccount.bankConnectionId` is `SetNull` (not `Cascade`) specifically so
  revoking a `BankConnection` can never cascade into deleting accounts that still
  have `Transaction` rows pointing at them (which would itself violate
  `Transaction.account`'s restrictive default and abort the whole operation).
  `TransactionEvidence.statementImportId` is `SetNull` for the same reason, and
  deliberately does not affect the evidence row's `rowFingerprint` — re-import
  dedup keys on the fingerprint, not the (now-nullable) import id, so deleting a
  `StatementImport` session never defeats future duplicate detection.
- `accountsRouter.delete` already guards: archives (does not delete) an account
  that has any transactions, rather than hitting the database's restrictive
  foreign key.
- `recurringRouter.delete` never hard-deletes a `RecurringPayment` — it ends it
  (`status: ENDED`) and only removes un-matched future projections, so there is
  no `ExpectedPayment`/`Transaction` orphan path.

**Findings fixed (additive only):**
- **`BankConnection.providerItemId` had no index**, despite being looked up on
  every inbound provider webhook (`bank-feed.service.ts`'s webhook handler) — a
  full-table scan on the hottest, externally-triggered code path. Added
  `@@index([providerItemId])`.
- **`categoriesRouter.delete` (web) had no guard** against deleting a category
  still referenced by transactions, rules, budgets, merchants, or subcategories —
  the database's foreign key would reject it, but the generic error handler then
  returns an unhelpful `500 Internal server error` instead of a clear response.
  Added the same existing-references check `accounts.routes.ts` already uses,
  now returning `409` with a breakdown of what's still using the category.
- **The mobile category-delete endpoint detached transactions/budgets/children
  but not `Merchant.defaultCategoryId`** — the same class of gap, just for one
  additional referencing field. Added the missing `merchant.updateMany` detach
  step alongside the existing ones in the same handler.

No destructive migration was needed for any of the above — the new index is a
plain additive `CREATE INDEX`, and the two route fixes are application-code only.

## 6. Auth/session security audit (§6) and API input security (§7)

Reviewed `jwt.ts`, `mobile-session.ts`, `mobile-middleware.ts`, `password.ts`,
`rateLimit.ts`, and `middleware/error.ts`. The existing design was already
sound — no vulnerabilities found — and is now backed by HTTP-level regression
tests in `packages/server/src/routes/phase6-security.test.ts`:

- **Access tokens**: HS256, short-lived, constant-time signature check
  (`timingSafeEqual`). Tested: missing header, malformed header, expired token,
  invalid signature — all `401`.
- **Refresh tokens**: opaque, stored only as a SHA-256 hash, single-use with
  rotation; presenting an already-rotated/revoked token is treated as theft and
  revokes every token for that device. Tested end-to-end (rotate → reuse →
  device fully revoked, including the token from the legitimate rotation).
- **Logout/revocation**: revoking a device immediately invalidates its
  previously-issued access token, not just future refreshes (tested).
- **Password hashing**: scrypt, per-password random salt, constant-time
  comparison (pre-existing `password.test.ts` coverage, re-confirmed here).
- **Login/registration throttling**: `authLimiter` (20 requests / 15 min / IP)
  is applied to register, login, and refresh — confirmed by the rate limiter
  itself blocking this test file's first draft when it registered too many
  users too fast; the test suite was restructured to a small shared fixture set
  to work within that same limiter rather than special-casing tests.
- **Ownership middleware**: every mobile route scopes its Prisma query by
  `req.mobileAuth.userId`. Tested cross-user isolation for accounts,
  transactions (via Activity), budgets, statement imports, Direct Debit
  mandates, and the Review Centre's merge/pair actions — an attacker account
  gets `403`/`404` or an empty/filtered list, never another user's data.
- **Input security**: oversized statement upload → `413` (previously fell
  through to a generic `500`; the error handler now recognises body-parser's
  entity-too-large error precisely — see below). Malformed/unparseable CSV →
  recorded as a `FAILED` import with `201`, not a crash. An `accountId`
  belonging to another user is rejected as `404` (ownership is checked before
  any write). Invalid/non-existent transaction ids in the transfer-pairing
  endpoint return a clean `4xx`, never a raw error.
- **No raw stack traces**: confirmed the global error handler never serialises
  `err.stack` or `err.message` for unexpected errors — only a fixed
  `"Internal server error"` string (logged server-side only). Added precise
  `413`/`400` branches for body-parser's entity-too-large/parse-failed errors
  so a client input error is no longer folded into a generic `500`.
- **CSV formula injection**: covered in §2.3 above (both export code paths).
- **SQL injection**: not applicable in the traditional sense — every query goes
  through Prisma's parameterised query builder; no raw SQL string
  concatenation exists anywhere in the codebase (verified by grep for
  `$queryRawUnsafe`/`$executeRawUnsafe`, both absent).
- **Path traversal**: statement filenames are sanitised
  (`filename.replace(/[\\/]/g, "_")`) before being stored/displayed, and are
  never used to construct a filesystem path — uploaded content is parsed
  in-memory only and never written to disk.

## 7. Production migration rehearsal (§4)

Performed on two disposable PostgreSQL 16 databases (never production), created
inside the same embedded-Postgres instance used for the test suite.

**Rehearsal 1 — fresh install.** Created an empty database, ran `prisma migrate
deploy` to apply all 10 migrations (`init` through
`production_readiness_indexes`) in order. Result: applied cleanly with no
errors; `prisma migrate status` reports "Database schema is up to date"; a
`prisma migrate diff` from the live database back to `schema.prisma` produces
an **empty migration** (zero drift — the applied migrations exactly reproduce
the current schema). Final state: 26 tables, 88 indexes.

**Rehearsal 2 — upgrade of an existing installation.** Created a second empty
database and applied migrations only through `financial_insights` (the last
Phase 4 migration — i.e. an installation as it stood immediately before Phase
5). Seeded realistic data at that schema version: a user (with its default
categories), a bank account with a real balance, 20 transactions spanning
income and everyday spending, a budget, and a Direct Debit mandate. Then
applied the two held-back migrations (`statement_import_review`,
`production_readiness_indexes`) on top — simulating exactly what a real
production upgrade does. Verified afterward:

| Check | Result |
|---|---|
| User row survives | ✅ |
| `User.timezone` still defaults correctly (additive column from an earlier phase) | ✅ `Europe/London` |
| Account balance unchanged by the upgrade | ✅ unchanged |
| All 20 transactions still present | ✅ |
| Budget row + limit intact | ✅ |
| Direct Debit mandate intact | ✅ |
| Categories intact | ✅ |
| New Phase 5/6 tables (`StatementImport`, `TransactionCorrection`, …) exist and are queryable | ✅ (empty, as expected for data that predates them) |

No data loss, no errors, no manual intervention required. Both rehearsals
confirm the migration chain is safe to run against a real production database
with `prisma migrate deploy` — the only command this project's runbooks ever
recommend for production. `prisma migrate reset`, `prisma db push`, `db:reset`,
and `db:seed` were not used at any point in this phase, on any database.

## 8. Logging/privacy audit (§8)

Reviewed every `logger.*`/`console.*` call site in the backend (11 total)
plus the Android diagnostics pipeline. **No disclosure found** — a clean bill
of health, unlike the financial-integrity findings above where real gaps
existed.

- Every backend log call passes only IDs, counts, cron/interval config, or an
  `Error.message` string — never a raw request body, header, or secret value.
- `logger.ts` already redacts a denylist of field **names**
  (`password`, `token`, `tokenHash`, `csrfSecret`, `sessionSecret`,
  `twoFactorSecret`, `totp`, `authorization`, `cookie`, …) from any metadata
  object before it's serialised, defense-in-depth on top of the above.
- **Plaid/TrueLayer provider errors are deliberately opaque**: TrueLayer's
  `sanitizeError()` reduces every failure to `"timeout"` or `"network error"`
  before it's ever thrown; Plaid's provider throws fixed strings like
  `` `Plaid API error (${res.status})` `` — never the response body, and never
  the request (which is what would carry `PLAID_SECRET`/`client_id`).
  `env.PLAID_SECRET` / `env.MOBILE_JWT_SECRET` / `env.OPEN_BANKING_DATA_KEY`
  are used only as cryptographic/API-client inputs, never concatenated into a
  string that could reach a log or an error message.
- **`DATABASE_URL`** is read once in `env.ts` (schema-validated, never logged)
  and used only to construct the Prisma client; no code path echoes it.
- **Full bank account numbers / IBANs**: both Open Banking providers mask
  these (`••••1234`) at the point of receipt from the provider API — the
  unmasked value exists only transiently in a local variable during masking
  and is never stored, returned, or logged. Confirmed no `console.*`/`logger.*`
  call exists anywhere in either provider file.
- **Raw notification/statement contents**: by design (Phases 1 and 5), only a
  redacted title/text and a normalized row fingerprint are ever stored —
  never the original notification or statement bytes. The Android
  `DiagnosticsRepository` (backs the in-app "Notification diagnostics" screen)
  is explicitly documented in its own source as "no raw text retained" and is
  in-memory only, never persisted to disk or sent anywhere.
- **Passwords**: hashed with scrypt before storage; `verifyPassword`/
  `hashPassword` never log the plaintext or the hash.

## 9. Android — upgrade migration, navigation, offline & performance (§20–24)

**Room upgrade migration (§20)** — added a genuine end-to-end test
(`RoomMigrationTest`'s "full chain v1 to v7") that seeds a real v1-shaped
on-disk database and opens it through Room's actual production migration
runner (`Room.databaseBuilder(...).addMigrations(*ALL_MIGRATIONS).build()`,
exactly what `DirectBankingDatabase.build()` does at app startup) — not by
invoking each `Migration` object by hand as the pre-existing pairwise tests
do. Confirms the full 1→2→3→4→5→6→7 chain runs without error, pre-existing
data (`approved_source`, `parsed_import`) survives every step, and the
database is fully usable at v7 afterward. `fallbackToDestructiveMigration()`
is not configured anywhere, so any gap in the chain would fail loudly
(exactly what this test now proves doesn't happen) rather than silently
wiping the user's local data. This is the strongest verification available
without a physical device; the literal `adb install -r` over an aged
real-device install remains a manual step (see the runbook).

**Navigation (§21)** — verified by code inspection: all 21 routes referenced
by the nav graph have a registered `composable()` destination (21 routes, 21
destinations, no orphans). Every screen named in the brief exists and is
reachable: Home, Activity, Payments (Direct Debits/Subscriptions/Recurring/
Upcoming via the combined Payments screen), Insights (Overview/Categories/
Merchants/Budgets/Cash flow/Net worth tabs), and Settings (Accounts, Bank
connections, Notification diagnostics, Review Centre, Import bank statement,
Export transactions).

**Offline & network failure behaviour (§22–23)** — verified by code
inspection: every major screen and its ViewModel uses the shared
`Async.Loading`/`Async.Success`/`Async.Failure` pattern (a failure never
throws past the UI layer — it renders a retry state) and/or the `Cached<T>`
wrapper with an `isStale` flag (Home's insights overview reads from the Room
`insights_cache` table on a network failure and displays "Showing saved
data — couldn't reach the server" rather than blanking). No screen in the
codebase renders a raw exception or crashes on a failed request.

**Performance (§24)** — verified by code inspection, consistent with the
Phase 6 database audit above: Activity uses server-side pagination
(`limit`/`offset`, never loads a full history into memory), the insights
aggregations run as indexed Postgres queries (not loaded into
application memory and summed client-side), and statement import processes
rows in a single staged-then-committed pass bounded by `STATEMENT_MAX_BYTES`
rather than holding an unbounded parsed structure.

### What still requires a physical device or real external credentials

The following are genuinely outside what this environment can execute (no
Android device/emulator, no real Plaid Sandbox credentials, no real Monzo/
Revolut notification traffic) and are documented as manual test plans rather
than claimed as automated:

- §9–10: Plaid Sandbox end-to-end connect/sync/webhook flow — see
  `docs/OPEN_BANKING.md` for the exact manual test plan.
- §11: real Monzo/Revolut notification capture on a device.
- §20 (literal step): `adb install -r` over an aged real install — the Room
  logic itself is proven by the full-chain test above; only the OS-level
  install/upgrade mechanics remain untested here.
- §22 (literal step): toggling a real device's network off/on. The
  offline-rendering *logic* is verified by code inspection above; a live
  airplane-mode session on a device is the remaining manual check.

## 10. Versioning (§26)

Checked the current values rather than bumping arbitrarily:
`android/app/build.gradle.kts` has `versionCode = 1`, `versionName = "1.0.0"`
— still the toolchain default. There is no evidence anywhere in the repo (no
`CHANGELOG`, no release git tag, no version-history doc) that any APK built
from this codebase has ever been signed and distributed. The brief's
instruction to increment "relative to any previous distributed production
APK" therefore has nothing to increment relative to — this is the first
formal release candidate to come out of the Phase 1–6 work, so
`versionCode = 1` / `versionName = "1.0.0"` is left as-is and reported as the
release candidate's version. **The moment an APK built from this codebase is
actually distributed (to a device, a store track, or testers),
`versionCode` must be incremented for every subsequent build** —
`docs/ANDROID_RELEASE.md` states this explicitly so it isn't missed next time.

## 11. Health/operational checks (§27)

`GET /api/healthz` (`health.routes.ts`) already exists and is mounted
unauthenticated (correct — uptime monitors shouldn't need credentials) ahead
of the protected router. It checks two things and only two things:

- **Server alive** — the process is up and answering HTTP at all.
- **Database reachable** — `SELECT 1` against Postgres; on failure responds
  `503` with `{"status":"degraded","db":"down",...}` rather than throwing.

Response body is `{status, db, time}` only — no environment values, no
connection details, no stack traces. No changes were needed here; it already
meets the brief.

Recommended PM2 operational checks (documented in
`docs/PRODUCTION_DEPLOYMENT.md`):

```bash
pm2 status                          # process up/down, restart count, uptime
pm2 logs project-direct-banking     # tail recent logs (already redacted — see §8)
pm2 save                            # persist the process list across reboots
```

## 12. Security scan for committed secrets (§34)

Searched every git-tracked file (278 total) for the patterns named in the
brief: `PLAID_SECRET=`, a real-looking `DATABASE_URL=postgres...`, JWT/session
secret literals, private key headers (`BEGIN PRIVATE KEY` etc.), hardcoded
`access_token` values, and keystore files. **Nothing found.**

- Only `.env.example` is tracked — a template with empty placeholders for
  every real secret (`PLAID_SECRET=`, `TRUELAYER_CLIENT_SECRET=`,
  `OPEN_BANKING_DATA_KEY=`) and clearly-labelled dev-only defaults for
  non-sensitive local Postgres config (`devpassword`, documented in the file
  itself as "SAFE DEVELOPMENT DEFAULTS only... never use in production").
- No `.jks`/`.keystore`/`keystore.properties` file is tracked.
- `.gitignore` (both root and `android/`) already excludes `.env`, `.env.*`,
  `android/keystore.properties`, and `*.keystore`.
- No `BEGIN PRIVATE KEY` (or RSA/EC variants) anywhere in the tree.
- No hardcoded `access_token` literal anywhere in the tree (consistent with
  §9's confirmation that Plaid's `access_token` is encrypted immediately on
  receipt and never persisted in plaintext, let alone committed).

## 13. Dependency review (§35)

Reviewed `pnpm outdated -r`, `pnpm audit`, and the Android
`gradle/libs.versions.toml`. Per the brief, **no major upgrades were
performed** — findings are reported for a dedicated future pass rather than
risked against this release's test coverage under time pressure.

### pnpm — known security findings (`pnpm audit`)

**9 findings: 1 critical, 2 high, 6 moderate.** All require a **major**
version bump to fix — no non-major patch exists for any of them (confirmed:
`react-router-dom`'s registry has no `6.30.5`+; the advisory's fix only
shipped starting in the 7.x line).

| Severity | Package | Real exposure in this project |
|---|---|---|
| Critical | `vitest` (needs 2.x→3.x) | Only triggers when the **Vitest UI server** (`vitest --ui`) is running. No script in this repo ever passes `--ui`; the feature is never invoked by anything committed. Dev/test-only dependency — never shipped to the server or the Android app. |
| High | `vite`, `nanoid` (transitive via `vitest`/`vite`) | Same: dev/test-tooling only, pulled in transitively by `vitest`, not part of the deployed server bundle or the web app's built output. |
| Moderate ×3 | `esbuild`, `vite` (path traversal, `launch-editor` NTLM hash disclosure) | All three are dev-server-only issues (local `vite dev`/`pnpm dev`), not present in the built static output that's actually deployed. |
| Moderate ×3 | `react-router` / `react-router-dom` (open redirect via backslash in `<Link>`, open-redirect-to-XSS, SSR-hydration constructor injection) | Ships in the web app's built bundle, so this is the one category with genuine (if moderate) production relevance. Mitigating factor confirmed by code inspection: **this app has no server-side rendering** (`packages/web` is a pure client-rendered SPA — no `renderToString`/`hydrateRoot` anywhere in its source), so the SSR-hydration-specific advisory's attack surface doesn't exist here. The open-redirect findings remain a real, if narrow, concern for the web app's own navigation. |

**Recommendation**: schedule a dedicated dependency-upgrade pass (not part of
this hardening phase) for `vitest` 2→3 (re-running the full 178-test suite
afterward) and `react-router-dom` 6→7 (a breaking API change for the web
app's routing, needing its own regression pass) — bundled together since
both require updating test/build tooling regardless. Until then, the
Android app (the project's primary client) is entirely unaffected by any of
these findings — none of the vulnerable packages are Android/Gradle
dependencies.

### Other outdated pnpm dependencies (no known CVE, informational only)

`@prisma/client`/`prisma` (5→7), `express` (4→5), `react`/`react-dom` (18→19),
`typescript` (5→7), `zod` (3→4), `tailwindcss` (3→4), `@types/*` majors — all
current pinned versions are actively maintained, receive security patches on
their own line, and have no open advisory. Left alone for the same reason:
each is a breaking major with its own migration effort, better scheduled
deliberately than bundled into a stabilization phase.

### Android / Gradle

`gradle/libs.versions.toml` versions (AGP 8.10.0, Kotlin/KSP 2.3.10, Room
2.8.4, Compose BOM 2024.12.01, OkHttp 4.12.0, coroutines 1.9.0, Plaid Link SDK
6.0.0, …) were already kept current through Phases 3–5 as part of resolving
real build/compatibility requirements (e.g. KSP2 requiring AGP ≥8.10, Kotlin
2.3 removing the old `kotlinOptions` DSL). No outdated-major or known-CVE
finding turned up in this review; nothing to change here.
