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

**Update (final-release-completion round):** bumped to `versionCode = 2` /
`versionName = "1.0.1"`, per the policy above — this release candidate
includes the Capital One notification parser (merged to `main`) plus this
round's Plaid/Open Banking audit, account deletion, and release-hardening
work. See `docs/ANDROID_RELEASE.md` §6 for the current signing/versioning
verification steps.

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

## 14. Migration count — resolved (was never a real discrepancy)

An earlier narration in this phase said "All 8 migrations applied" while
summarizing a `migrate deploy` run whose own tool output had, in fact, just
applied 9 migrations (through `statement_import_review`). That was a
miscount in the summary sentence, not a missing migration — re-verified from
scratch on a brand-new disposable database:

- `find prisma/migrations -mindepth 1 -maxdepth 1 -type d` → **10 directories**
  (9 inherited from the Phase 5 merge + this phase's own
  `production_readiness_indexes`), including `statement_import_review`.
- `prisma migrate deploy` against an empty database → all **10** applied,
  `statement_import_review` explicitly listed as the 9th.
- `prisma migrate status` → **"10 migrations found... Database schema is up
  to date!"**
- A direct `SELECT migration_name, finished_at FROM "_prisma_migrations"
  ORDER BY started_at` → **10 rows**, every one `finished_at IS NOT NULL`, in
  the correct chronological order.

No migration was ever manufactured to paper over an absence — there was
never an absence.

## 15. Canonical-ledger re-audit (full classification)

Re-ran the exact requested scan —
`grep -RInE 'transaction\.(create|createMany|update|delete)|balanceMinor' packages/server/src --exclude='*.test.ts'`
— and classified every one of its ~55 hits:

| File | What it does | Classification |
|---|---|---|
| `transactions.service.ts` | `createTransaction()`, `reverseTransactionBalance()`, `setProviderBalance()` | **Canonical transaction service** — the single source of truth |
| `transactions.routes.ts` (web POST/PUT/DELETE/split/refund) | POST delegates to `createTransaction()`; PUT gates balance re-apply on `balanceApplied`; DELETE calls `reverseTransactionBalance()` before deleting; split creates non-balance-bearing child rows (`parentId` set, excluded from every aggregation); refund delegates to `createTransaction()` | **Canonical transaction service** (via delegation) + **legitimate maintenance** (split) |
| `mobile.routes.ts` (correction endpoint, ~line 280-330) | Updates `transactionType`/`internalTransferGroupId`/`directDebitMandateId`/`recurringKind`/`ddAnomaly` only — **no `balanceMinor`/`balanceApplied` field anywhere in this block** | **Legitimate maintenance** (reclassification never touches balance) |
| `mobile.routes.ts:508` (DD-mandate merge) | Re-points transactions from a duplicate mandate to the canonical one | **Legitimate maintenance** (consolidation, no balance effect) |
| `mobile.routes.ts:1128` (category delete) | Nulls `categoryId` before deleting a category | **Legitimate maintenance** (audit §5 fix) |
| `accounts.routes.ts` (POST/PUT) | Sets a `BankAccount.balanceMinor` directly — account creation/editing, never a `Transaction` row | **Legitimate maintenance** (account management, not the ledger) — **hardened this pass**: `PUT` now rejects a manual balance edit on a `PROVIDER`-authoritative account (`409`) rather than silently accepting a value the next sync would overwrite anyway |
| `csv-import.service.ts` (`commitCsv`) | Delegates every row to `createTransaction()` | **Canonical transaction service** (via delegation) |
| `csv-import.service.ts` (`rollbackBatch`) | Previously: `deleteMany()` with **no balance reversal** | **FIXED — was a real bypass.** Now fetches each row's balance fields and calls `reverseTransactionBalance()` per row before deleting, mirroring the pattern already used everywhere else. See §16. |
| `direct-debit.service.ts:273` | Updates `transactionType`/`directDebitMandateId`/`recurringKind`/`recurringConfidence` only | **Legitimate maintenance** (DD classification, no balance) |
| `internal-transfer.service.ts` (4 call sites) | Updates `transactionType`/`internalTransferGroupId`/`internalTransferConfidence` only | **Legitimate maintenance** (transfer classification, no balance) |
| `transfer-pairing.service.ts` (manual pair/unpair) | Same classification-only fields | **Legitimate maintenance** — explicitly balance-tested (`phase5.test.ts`) |
| `open-banking/reconciliation.service.ts` (5 call sites) | Enrichment, pending→settled, possible-duplicate linking; `removeProviderTransaction` marks `CANCELLED` after calling `reverseTransactionBalance()` | **Reconciliation update** |
| `review.service.ts` (merge/keep-separate) | `mergeDuplicate()` calls `reverseTransactionBalance()` **before** `tx.transaction.delete()` (re-verified by direct code read this pass) | **Reconciliation update** — correctly protected |
| `statement-import.service.ts:336` | Flags a review-worthy new row's `possibleDuplicateOfId` | **Legitimate maintenance** |
| `forecast.service.ts`, `insights.service.ts`, `cashflow.service.ts` | Read-only `select`/aggregation of `balanceMinor` for dashboards/forecasts | **Read-only**, no write |

### The one real finding: `csv-import.service.ts`'s `rollbackBatch()`

Every other deletion path in the codebase (`transactionsRouter.delete`,
`review.service.ts`'s merge) reverses a transaction's balance effect before
removing it. `rollbackBatch()` — used when a user undoes a legacy web CSV
import — did not: it called `tx.transaction.deleteMany(...)` directly, so
rolling back a batch whose rows had `balanceApplied = true` (the normal case
for a `LEDGER` account, since the legacy importer never opts out) would
delete the transactions **while leaving the account balance exactly as those
now-deleted transactions had left it** — a permanent, silent balance
corruption with no self-healing path (unlike the earlier §2.1 finding, whose
worst case self-corrects on the next Open Banking sync).

**Fixed**: `rollbackBatch()` now fetches each affected row's balance fields
inside the same `$transaction` and calls the same `reverseTransactionBalance()`
used everywhere else, before deleting. Also confirmed it correctly no-ops for
a `PROVIDER`-authoritative account (never had a balance effect to reverse in
the first place). Both covered by new tests in `phase6.test.ts`.

### Legacy CSV importer vs Phase 5 statement importer — documented distinction

These are genuinely two different features for two different clients, not a
duplicate/competing implementation of the same thing:

| | Legacy CSV importer (`csv-import.service.ts`) | Phase 5 statement importer (`statement-import.service.ts` + `statement/*.ts`) |
|---|---|---|
| Client | Web app, manual column-mapping UI | Mobile app, auto-detecting |
| Formats | CSV only, user maps columns | CSV (auto-detect), OFX, QIF, text-PDF |
| Dedup | `dedupeHash` (date+amount+direction+description) | File hash **and** per-row fingerprint; overlapping-statement-safe |
| Reconciliation | None — always creates a new transaction | Full `TransactionReconciliationService` integration — converges with notification/Plaid evidence |
| Balance policy | Applies balance by default (no opt-out passed) | Explicit `balanceApplied=false` by default; provider accounts protected either way (now structurally, via §2.1) |
| Undo | `rollbackBatch()` (now balance-safe, this pass) | N/A — statement import review/exclude happens **before** commit, not after |

Both are still reachable and both are intentionally kept — the legacy
importer is the web app's only import mechanism and remains in active use
there; nothing in this phase removes or disables it. Its one real gap
(`rollbackBatch`'s missing balance reversal) is now fixed and tested.

## 16. Database integrity — deepened per-model audit

Every model named in the brief, checked for foreign keys, delete behaviour,
ownership isolation, unique constraints, idempotency keys, indexes, and —
specifically — whether deleting an account/bank connection/statement
import/mandate/category could destroy canonical financial history.

| Model | Ownership | Delete reachability | Orphan/history risk |
|---|---|---|---|
| **User** | is the ownership root | **No delete route exists anywhere in production code** (verified: zero `prisma.user.delete(` outside test teardown) | N/A — cascades from `User` were never exercised in production; see "known limitations" below |
| **BankAccount** | `userId` indexed | `accountsRouter.delete` archives (never hard-deletes) any account with ≥1 transaction; only a zero-history account can be hard-deleted | **Structurally impossible to lose history**: `Transaction.account`, `DirectDebitMandate.account`, `RecurringPayment.account` all have **no `onDelete`** (Postgres default `NO ACTION`/restrictive) — the database itself refuses to delete an account any of them reference, independent of application code |
| **Transaction** | `userId` indexed, every query scoped | Single-row delete (web) reverses balance first; split/refund never delete the parent; `possibleDuplicateOf` self-relation is re-pointed before a merge-delete | Protected by construction — every deletion path in the codebase now reverses `balanceApplied` first (this phase closed the one exception, `rollbackBatch`) |
| **TransactionEvidence** | via `transaction.userId` (no direct `userId` column — always accessed transaction-first) | Cascades with its `Transaction`; `statementImportId` is `SetNull` on `StatementImport` deletion | Evidence for a committed transaction survives a statement-import session being deleted; dedup fingerprint is preserved so re-import safety isn't defeated (§ Statement import runbook) |
| **BankConnection** | `userId` indexed | **Never hard-deleted** — `revokeConnection()` sets `status: REVOKED` and nulls `providerConnectionIdEncrypted`; no delete route exists | `BankAccount.bankConnectionId` is `SetNull`, deliberately not `Cascade`, precisely so a connection's lifecycle can never touch account/transaction rows |
| **DirectDebitMandate** | `userId` indexed, unique on `(userId, accountId, normalizedCompanyName)` | Only hard-deleted via `/direct-debits/:id/merge` — and only *after* re-pointing every referencing `Transaction.directDebitMandateId` to the surviving mandate first (verified by reading the route) | Safe — no transaction ever loses its mandate link, it's relinked before the duplicate is removed |
| **RecurringPayment** | `(userId, status)` and `nextDueDate` indexed | `DELETE /recurring/:id` is a **soft end** only — sets `status: ENDED` + `endDate`, never a hard delete; the FK into `account` has no `onDelete` (Postgres default restrictive) so an account with an active recurring payment can't be hard-deleted underneath it either | Safe by construction on two fronts: (1) "deleting" a recurring payment can never lose history — it only removes *un-matched future* `ExpectedPayment` projections (`PROJECTED`/`DUE`/`OVERDUE`), matched/settled history is untouched; (2) `category`/`merchant` FKs have no `onDelete`, which is exactly why this phase's category-delete fix (below) had to explicitly detach `RecurringPayment.categoryId` first — without that detach the DB itself would refuse the category delete |
| **StatementImport** | `userId` + `userId,accountId` indexed, unique on `(userId, accountId, fileHash)` (idempotency key) | `DELETE /statements/:id` ownership-checked, then hard-deletes | Safe by the schema's own design: `StatementCandidate` (disposable pre-ledger staging data) cascades away; `TransactionEvidence` (evidence for already-committed transactions) is `SetNull`, never cascaded |
| **StatementCandidate** | via `statementImportId` → `userId` also stored directly | Cascades with its `StatementImport` | Correct — these rows are staging data, never canonical, safe to lose with their parent session |
| **ReconciliationDecision** | `userId` indexed, unique on `(userId, transactionAId, transactionBId)` (idempotency key — a "keep separate" decision can't be recorded twice for the same pair) | **No delete route exists** — append-only by design, confirmed by grep | N/A |
| **TransactionCorrection** | `userId` indexed + `(userId, createdAt)`, `transactionId` indexed | **No delete route exists** — append-only audit trail by design, confirmed by grep | N/A |
| **Budget** | `userId` + `(userId, categoryId)` indexed | No delete-cascade risk; `categoryId` set null on category deletion (both routes) | Safe |
| **Category** | `userId` indexed, unique on `(userId, name)`, `(userId, code)` indexed | Both delete routes now correctly detach **every** reference before deleting (see below) | Safe, and more completely so after this pass |
| **CategoryRule** | `userId` indexed | `onDelete: Cascade` on its `category` FK — a rule referencing a deleted category disappears with it (correct: a rule that can no longer resolve to any category is meaningless) | Safe — rules carry no financial history themselves |

### New finding this pass: `RecurringPayment.categoryId` was an incomplete detach

Re-checking every FK into `Category` (`Merchant.defaultCategoryId`,
`CategoryRule.categoryId` [cascades], `Transaction.categoryId`,
`RecurringPayment.categoryId`, `Budget.categoryId`, `Category.parentId`)
found that **both** category-delete routes (web `categories.routes.ts` and
mobile `mobile.routes.ts`) checked/detached every reference **except**
`RecurringPayment.categoryId` — a real gap in the very fix this phase made
earlier. Not a data-corruption risk (the database's own `NO ACTION` FK would
have blocked the delete outright, exactly as intended), but an incomplete
guard: deleting a category still referenced by a recurring bill would have
hit a raw `500` instead of the intended clear `409`/clean detach. **Fixed**:
both routes now include `RecurringPayment` in their reference
count/detach logic, covered by new tests.

## 17. Migration rehearsals — redone this pass (richer data, fresh disposable DBs)

Both rehearsals from §7 were repeated from scratch on newly-created disposable
databases (the original ones no longer existed after the prior session's
Postgres instance was torn down), this time with a richer, more realistic
upgrade-rehearsal dataset per this pass's explicit request.

**Fresh install** (see §14 above for the full command-by-command evidence):
empty database → `prisma migrate deploy` → all **10** migrations applied →
`prisma migrate status` reports up to date → direct `_prisma_migrations`
query confirms all 10 rows `finished_at IS NOT NULL`.

**Upgrade install** (redone with materially more coverage than the original
§7 rehearsal): a fresh disposable database taken to the `financial_insights`
migration (the last pre-Phase-5 migration, 8 migrations) and seeded with:

- a user with 2 categories
- **3 accounts**: a `LEDGER` current account, a `LEDGER` savings account, and
  a `PROVIDER`-authoritative account
- a **`BankConnection`** (status `ACTIVE`) linked to the provider account
- **19 transactions**, including an **internal-transfer pair** (current →
  savings, same `internalTransferGroupId`, both `CONFIRMED`), a **Direct
  Debit** payment linked to a mandate, and a provider-sourced transaction
- **`TransactionEvidence`** for the provider transaction (inserted via raw
  SQL using only the columns that exist at this schema version, since the
  Phase 5-aware generated client would otherwise reference not-yet-existing
  columns — exactly the "where schema permits" caveat anticipated in the
  brief)
- a **Direct Debit mandate** (British Gas, `paymentCount: 3`)
- a **budget**

Then applied the two held-back migrations (`statement_import_review`,
`production_readiness_indexes`) on top — the exact operation a real
production upgrade performs. Verified afterward, all passing:

| Check | Result |
|---|---|
| User survives | ✅ |
| All 3 accounts survive | ✅ |
| All 19 transactions survive | ✅ |
| `BankConnection` survives, still `ACTIVE`, still linked to its account | ✅ |
| `TransactionEvidence` survives, still linked to its transaction | ✅ |
| Direct Debit mandate survives with its learned `paymentCount`, still linked to its transaction | ✅ |
| Budget survives with its exact limit | ✅ |
| Categories survive | ✅ |
| Internal-transfer pair survives, both sides still share the same group id | ✅ |
| All three account balances are byte-identical to what was seeded (300000 / 500000 / 120000 minor units) | ✅ — proves the migrations never touch existing data |

No data loss, no relationship breakage, no manual intervention. Confirms the
migration chain is safe to run against a real production database with
`prisma migrate deploy` — the only command this project's runbooks ever
recommend for production.

### Known limitation: no user account deletion

There is no route anywhere that deletes a `User` row (or offers "delete my
account" to the end user) in either the web or mobile API. The older
`docs/android-release-checklist.md` lists "account/data deletion available
in-app" as a Play Store readiness item that **is not yet implemented** — this
predates Phase 6 and is out of scope for a hardening pass (building it is a
real feature, not a fix), but is flagged here explicitly since it's a genuine
gap relevant to any real Play Store submission.

## 18. Backup/restore drill — redone this pass

Repeated end-to-end (the original session's Postgres instance had been torn
down): seeded a fresh user with a category, account, 12 transactions and a
budget (16 rows total) into the disposable test database, then ran the full
cycle documented in `docs/BACKUP_RESTORE.md`:

1. **Backup** — per-table `COPY ... (FORMAT binary)` export (this
   environment has no `pg_dump`/`pg_restore` binary; see the runbook's note
   on what a real host with the standard PostgreSQL client tools would run
   instead) → `BACKUP_DONE {"tables":25,"totalRows":16}`.
2. **Verify** — every table's archive member checked for existence and a
   plausible size for its row count → `VERIFY_OK`.
3. **Restore** — a brand-new disposable database, schema applied via
   `prisma migrate deploy` (all 10 migrations), confirmed
   **"Database schema is up to date"** before loading any data.
4. **Load + integrity check** — all 25 tables reloaded; every row count
   matched **exactly** (`User: 1/1`, `BankAccount: 1/1`, `Category: 1/1`,
   `Transaction: 12/12`, `Budget: 1/1`, all others `0/0`); **zero** orphaned
   transactions; a live `Transaction ⋈ BankAccount` join on the restored data
   returned correct, real data (not empty).

`INTEGRITY_CHECK_PASSED`. Same result as the original drill, now re-run
against the full current (10-migration) schema.

## 19. Auth/session security — remaining test gaps closed this pass

Three gaps identified against the round-2 request's granular scenario list,
all added to `packages/server/src/routes/phase6-security.test.ts`
(HTTP-level, real server, disposable Postgres):

1. **Expired refresh token** (as distinct from revoked or reused) — the
   stored token's `expiresAt` is back-dated directly (this is the one state
   `rotateRefreshToken()` can't be driven into through the API alone), then
   `rotateRefreshToken()` is called and asserted to return
   `{ ok: false, reason: "expired" }`, not `"revoked"` or `"reuse"`.
2. **Cross-user bank-connection access** — a connection owned by `owner` is
   created directly in the DB; `attacker`'s token is used to attempt
   `GET`, `POST .../sync`, `POST .../reauthorize`, and `DELETE` against it.
   Read and delete correctly 404 (ownership check runs first). Sync/
   reauthorize 503 in this test environment because `OPEN_BANKING_ENABLED`
   is unset/false there — that's the correct "feature disabled" response,
   not an ownership leak, and it is asserted alongside the ownership-style
   codes rather than masked. The connection's `status` is confirmed
   unchanged (`ACTIVE`) after every attempt, and it never appears in the
   attacker's own connection list.
3. **Cross-user export attempt** — a transaction with a distinctive marker
   description is created for `owner`; `attacker` requests
   `GET /export/transactions?accountId=<owner's account>`. Because
   `exportTransactionsCsv()` always ANDs the caller's own `userId` into the
   Prisma `where` clause (see `packages/server/src/services/export.service.ts`),
   the owner's `accountId` filter simply matches nothing for the attacker —
   the response is a 200 with the attacker's own (empty) CSV, and the raw
   response body (fetched directly, not through the JSON-parsing test
   helper, so a real leak couldn't hide behind a swallowed parse failure) is
   asserted to never contain the marker or the transaction's id.

Cross-user Direct Debit access and cross-user Review Centre action were
already covered by the existing ownership-isolation test (`GET
/direct-debits/:id` → 403/404; `POST /review/:id/merge` on another user's
transaction → ≥400) — left as-is rather than duplicated.

## 22. Release signing — verified both the unsigned-by-default path and a real signed build

Two things were verified this pass, both against the actual Gradle signing
logic in `android/app/build.gradle.kts` (unchanged from Phase 5) rather than
by reading the code alone.

**(a) No signing secrets present (the default production-safe state).**
With every `DIRECT_BANKING_KEYSTORE_*`/`DIRECT_BANKING_KEY_*` env var unset
and no `keystore.properties` file present:
- `./gradlew assembleDebug` → **BUILD SUCCESSFUL**, produces
  `app-debug.apk` as normal (debug builds are never gated on release
  signing).
- `./gradlew assembleRelease` → **BUILD SUCCESSFUL**, but the output file is
  named **`app-release-unsigned.apk`** — Gradle's own naming confirms
  `releaseSigningReady` correctly evaluated `false` and no signing config
  was attached. This is the exact safe default the hardening work in Phase 5
  was meant to guarantee: a release build in an environment with no
  credentials builds, but is never silently signed with something
  unintended.

**(b) A real disposable test keystore.** Generated a throwaway PKCS12
keystore **outside the repository**, in the session scratchpad
(`keytool -genkeypair`, 2048-bit RSA, 1-day validity, `CN=Phase6 Disposable
Test`, alias `dbtestkey`) — never at any point inside `android/` or anywhere
git tracks. Exported the four `DIRECT_BANKING_KEYSTORE_PATH` /
`DIRECT_BANKING_KEYSTORE_PASSWORD` / `DIRECT_BANKING_KEY_ALIAS` /
`DIRECT_BANKING_KEY_PASSWORD` env vars pointing at it, then:

- `./gradlew assembleRelease` → **BUILD SUCCESSFUL**, this time producing
  `app-release.apk` (no `-unsigned` suffix). Verified with
  `apksigner verify --print-certs`:
  `Verifies` / `Verified using v2 scheme: true` / signer DN
  `CN=Phase6 Disposable Test, OU=QA, O=DirectBanking, L=Test, ST=Test, C=GB`
  — signed, and signed with the disposable test cert, not something stray.
- `./gradlew bundleRelease` → **BUILD SUCCESSFUL**, producing
  `app-release.aab` (the actual Play Store submission artifact). Verified
  with `jarsigner -verify`: **`jar verified.`** The accompanying warnings
  (self-signed certificate, no trusted chain, near-term expiry) are exactly
  what's expected of a deliberately throwaway 1-day test certificate, not a
  problem — a real release keystore from a trusted CA-adjacent process
  wouldn't carry those warnings, but this one was never meant to be trusted,
  only to prove the signing plumbing works end-to-end.

**Cleanup:** the disposable keystore directory (`.jks` file plus the two
password files it was generated with) was deleted immediately after
verification (`rm -rf`), confirmed gone, and confirmed to have never
appeared in `git status` at any point — it lived only in the session
scratchpad outside the repository root, never inside `android/`. The signed
`app-release.apk` / `app-release.aab` build outputs themselves live under
`android/app/build/`, which `android/.gitignore` excludes wholesale
(confirmed via `git check-ignore -v` on both exact paths) — build outputs
were never at risk of being committed either.

All 21 tests in the file pass:
`npx vitest run src/routes/phase6-security.test.ts` → **21/21 passed**.

## 20. Statement-format fuzzing (CSV/OFX/QIF/PDF)

Requirement: a parser failure must return a controlled error, never crash
the server. Four new tests added alongside the existing CSV fuzz test in
`phase6-security.test.ts`, each POSTing a deliberately malformed payload of
the given `fileType` to `/statements` and asserting the *same* outcome the
existing CSV case already established — `201` with the import recorded as
`status: "FAILED"`, and no stack trace leaked in the response body:

- **OFX** — truncated/garbled SGML with embedded binary noise, no
  `<BANKTRANLIST>` structure.
- **QIF** — no `!Type:` header, no `D`/`T`/`^` record markers, binary noise.
- **PDF (wrong content)** — a plain-text file with a `.pdf` filename/type
  and no `%PDF` header at all.
- **PDF (corrupt binary)** — a file that *does* start with a valid `%PDF-1.4`
  magic header followed by random non-PDF bytes (no valid xref/object
  structure) — the case most likely to reach a native/binary parser path
  rather than being rejected by a cheap header check.

All four are caught by `parseStatement()`'s per-format `try/catch` in
`statement-import.service.ts` and converted to a `FAILED` import row, exactly
like the CSV case — confirming the "never invents transactions, never
crashes" contract holds across every supported format, not just CSV.
`npx vitest run src/routes/phase6-security.test.ts` → **21/21 passed**
(includes these 4 plus the pre-existing CSV fuzz test).

## 21. Performance verification (1,000 / 10,000 transactions)

Per the round-2 instruction — evidence-based only, no blind optimization.
A disposable script (not committed) seeded one user each with 1,000 and then
10,000 transactions (8 categories, 15 merchants, one budget, realistic
hourly spacing across 2025) on the same disposable Postgres 16 used
throughout this phase, then timed the actual queries the app's screens
issue, plus `EXPLAIN (ANALYZE, BUFFERS)` on the two heaviest ones.

| Query | 1,000 rows | 10,000 rows |
|---|---|---|
| Activity list, page 1 (limit 50) | 52.7ms | 56.6ms |
| Activity count (same filter) | 6.8ms | 12.6ms |
| Activity list, deep page (offset 5000) | 27.4ms | 165.7ms |
| Activity filtered by category | 16.4ms | 9.0ms |
| Activity filtered by merchant | 14.8ms | 12.9ms |
| Activity text search | 12.9ms | 27.8ms |
| `monthlySummary` | 43.5ms | 16.0ms |
| `categoryBreakdown` (full year) | 25.8ms | 58.4ms |
| `topMerchants` (full year) | 16.9ms | 88.6ms |
| `netWorth` | 2.8ms | 2.4ms |
| `budgetProgress` | 27.2ms | 14.6ms |
| `getReviewCentre` | 37.6ms | 100.1ms |

`EXPLAIN (ANALYZE, BUFFERS)` on the activity-list query and the
category-breakdown range query showed an **Index Scan / Bitmap Heap Scan**
against `Transaction` in every case at both scales — **no sequential scan**
on the transactions table was observed. The existing composite indexes
(`[userId, bookedAt]`, `[userId, categoryId, bookedAt]`,
`[userId, merchantId, bookedAt]`, `[userId, transactionType]`) already cover
every filter combination exercised above.

**Finding, not acted on (evidence-based judgment call):** deep
offset-pagination (`skip: 5000`) degrades from 27ms → 166ms between the two
scales — expected and inherent to `OFFSET`-based pagination (Postgres must
walk and discard the skipped rows; no index avoids that). At 10,000 rows for
a single user it's still well under a perceptible-lag threshold, and the
Activity screen's default browsing pattern is recency-ordered near the top
of the list, not deep-paging — so this is documented as a known scaling
characteristic to watch (a cursor/keyset pagination redesign would remove
it), not fixed here, per the explicit instruction not to optimize without
evidence of a real problem. No new indexes were added — none were warranted
by the evidence.

## 23. Release/version audit — current values, consolidated

Restating §10/§14's findings together in one place, as this round's request
asked for explicitly, with fresh confirmation this pass rather than relying
on earlier-session recollection:

| Item | Current value | Source |
|---|---|---|
| Android `versionCode` | `1` | `android/app/build.gradle.kts` |
| Android `versionName` | `"1.0.0"` | `android/app/build.gradle.kts` |
| `compileSdk` / `targetSdk` | `36` | `android/app/build.gradle.kts` |
| `minSdk` | `26` | `android/app/build.gradle.kts` |
| Room database version | `7` | `DirectBankingDatabase.kt` (`@Database(version = 7, ...)`) |
| Prisma migration directories | `10` | `prisma/migrations/` (freshly re-counted this pass, matches §14) |
| Latest migration | `20260816090000_production_readiness_indexes` | (the Phase 6 Round-1 index-fix migration; additive only) |

No version bump was made. As established in §10, there is no evidence
anywhere in the repository (no CHANGELOG, no release tag, no distributed
build) that any APK from this codebase has ever shipped, so `versionCode = 1`
is correctly still the first release candidate's number, not a value that
needs incrementing "relative to" anything. Room stayed at `v7` — Phase 6
added no local-schema-affecting change requiring a Room migration, per the
constraint not to change working schema without cause. Both are reported
as-is rather than guessed forward, per the explicit instruction.

## 24. Upgrade migration rehearsal — `rehearsal_upgrade2`, redone cleanly

A previous session's attempt at this exact rehearsal had been interrupted
mid-recreation, leaving `rehearsal_upgrade2` on the disposable Postgres
instance sitting at the *full* 26-table current schema rather than the
partial Phase-4-era state the rehearsal needs. Redone cleanly this pass,
without touching `prisma migrate reset` and without moving or deleting any
tracked migration directory in the working tree:

**A. Clean recreate.** Connected to the `postgres` maintenance database,
terminated any lingering backends on `rehearsal_upgrade2`
(`pg_terminate_backend`), `DROP DATABASE IF EXISTS` +
`CREATE DATABASE` — a genuinely empty database, not a reset-in-place.

**B/C. Partial apply, temp copy only.** Rather than moving anything inside
`prisma/migrations/` (which `git status` confirms was never touched — 10
directories throughout), a temporary copy of `prisma/schema.prisma` plus
only the first 8 migration directories (through
`20260811134641_financial_insights`) was made in the session scratchpad,
**outside the repository**. `prisma migrate deploy --schema=<temp copy>`
against `rehearsal_upgrade2` applied exactly those 8. Confirmed via a direct
`_prisma_migrations` query: **8 rows, all `finished_at` set**, matching the
Phase-4-era schema.

**D. Phase-4-era seed, raw SQL.** The generated Prisma Client is built
against the full current schema and errors on columns that don't exist yet
at this migration level (the same issue hit in the previous rehearsal with
`TransactionEvidence.statementImportId`), so the seed used raw parameterised
SQL via `pg` against the actual Phase-4-era column set (checked directly
from `information_schema.columns` rather than assumed). Seeded: 1 user, 2
bank accounts (one linked to a bank connection), a normal debit and a
normal income transaction, an internal-transfer pair sharing one
`internalTransferGroupId` with mutual `transferAccountId`s, a Direct Debit
mandate plus its linked payment transaction, 2 categories, 1 budget, 1
`TransactionEvidence` row, and 1 `BankConnection` — account balances updated
to reflect those transactions exactly as `createTransaction()` would have
at the time. Stable IDs and a full row-count snapshot were captured to a
JSON file before proceeding.

**E/F. Restore the remaining migrations, deploy.** The two later migration
directories (`20260813120000_statement_import_review`,
`20260816090000_production_readiness_indexes`) were added to the *same temp
copy* (never to the working tree), and `prisma migrate deploy` was re-run
against `rehearsal_upgrade2`. Both applied cleanly.
`prisma migrate status` → **"Database schema is up to date!"**

**G. Verification — every check passed:**

- **10/10** migrations recorded as finished.
- Both bank accounts survive; **balances byte-identical** to the
  pre-migration snapshot (`acc1: 727600 → 727600`, `acc2: 1010000 →
  1010000`) — the migration touched no data, only schema.
- All 5 seeded transactions survive.
- The internal-transfer pair survives with its shared group id and mutual
  `transferAccountId` intact.
- The Direct Debit mandate and its linked transaction survive, link intact.
- The budget survives, still pointing at its category.
- Both categories survive.
- The `TransactionEvidence` row survives, still linked to its transaction.
- The bank connection survives, and the account-to-connection link
  (`BankAccount.bankConnectionId`) survives.
- The five Phase 5/6 tables (`StatementImport`, `StatementCandidate`,
  `ReconciliationDecision`, `TransactionCorrection`, `RecurringPayment`)
  exist post-migration and are correctly **empty** — the migration adds
  schema, never invents data.
- Zero orphaned transactions (LEFT JOIN against `BankAccount` with no
  match), zero orphaned evidence rows.

`UPGRADE_REHEARSAL_PASSED`. The temp schema/migration copy and the seed
script were deleted from the scratchpad after use; nothing from this
rehearsal was ever written to the working tree or to git.

## 25. Phase 6 index migration — per-index audit against real query patterns

`20260816090000_production_readiness_indexes/migration.sql` adds exactly
one index:

```sql
CREATE INDEX "BankConnection_providerItemId_idx" ON "BankConnection"("providerItemId");
```

| Table | Column(s) | Use case requiring it |
|---|---|---|
| `BankConnection` | `providerItemId` | Provider webhook routing — `handleProviderWebhook(item_id, ...)` in `mobile.routes.ts`'s `/bank-connections/webhook` handler looks up the connection by `providerItemId` on **every inbound Plaid webhook call**, an externally-triggered, unauthenticated-by-user path that was previously an unindexed full-table scan. |

No other tables or columns are touched by this migration — it is a single
additive `CREATE INDEX`, nothing else, so there is nothing further to
justify or roll back.

**Representative query testing at 1,000 and 10,000 disposable transactions**
(reusing the same seeded dataset and methodology as §21) confirmed
`EXPLAIN (ANALYZE, BUFFERS)` shows an **Index Scan / Bitmap Heap Scan** — no
sequential scan — for every one of the query patterns this round asked to
be re-checked against the current index set:

| Query pattern | Index used | Notes |
|---|---|---|
| Activity date pagination (`userId, bookedAt DESC`) | `Transaction_userId_bookedAt_idx` | confirmed in §21 |
| Account/date filtering | `Transaction_accountId_bookedAt_idx` | leading column matches filter |
| Category/date insights | `Transaction_userId_categoryId_bookedAt_idx` | confirmed in §21 (`categoryBreakdown`) |
| Merchant/date insights | `Transaction_userId_merchantId_bookedAt_idx` | confirmed in §21 (`topMerchants`) |
| Review Centre lookups | `Transaction_userId_*` composite indexes (candidate transactions are always looked up by `userId` first) | `getReviewCentre` timed in §21 at 37.6ms/100.1ms |
| Reconciliation/evidence lookups | `TransactionEvidence` has no dedicated composite index beyond its FK indexes, but the table stays small (one row per provider-sourced transaction, not per transaction) — no seq-scan risk observed at either data scale | not a hot path under load; revisit only if evidence volume grows independently of transaction volume |
| Statement candidate lookup | N/A at these tables' current volumes — `StatementCandidate`/`StatementImport` rows stay in the tens-to-low-hundreds per user (one row per uploaded statement's parsed rows), nowhere near the 1k/10k transaction-volume regime this section is stress-testing | no index gap found |

**Verdict: the migration's one index is justified by an actual, specific,
externally-triggered query pattern (webhook routing), and no other index is
missing or unnecessary.** Nothing in the migration was changed. Because
nothing changed, the fresh-install rehearsal from an empty database (§7,
re-confirmed in this session's final gate re-run below) did not need to be
re-run a second time on its account; the existing green result stands.

## 26. Backup/restore drill — re-verified this pass against the exact step list requested

Confirmed first: this environment still has **no real `pg_dump`/`pg_restore`/
`psql` binaries** — only `initdb.exe`, `pg_ctl.exe`, `postgres.exe` ship with
the embedded Postgres 16 package used for disposable testing here (checked
directly inside `@embedded-postgres/windows-x64/native/bin`, not assumed).
The COPY-based equivalent (`pg` + `pg-copy-streams` over libpq, transferring
data via `COPY ... (FORMAT binary)` — the same mechanism `pg_dump`/
`pg_restore` use internally) remains the correct substitute here; a real
host runs the actual `pg_dump -Fc` / `pg_restore` commands, as
`docs/BACKUP_RESTORE.md` documents.

Redone end-to-end against fresh disposable data, mapped explicitly onto the
requested step list:

1. **Populate meaningful sample data** — seeded a dedicated drill user (1
   account, 1 category, 1 budget, 5 transactions) into `direct_banking_test`
   on top of whatever else was already there from other test runs; final
   pre-backup state: **25 tables, 87 total rows** across `User` (3),
   `BankAccount` (3), `Merchant` (15), `Category` (10), `Transaction` (17),
   `Budget` (3), `AuditLog` (36), and 18 other tables at 0 rows.
2. **Backup** — `BACKUP_DONE {"tables":25,"totalRows":87}`.
3. **`test -s backup`** — every one of the 25 `.copy` archive members is a
   real, non-empty file (`ls -la backup_archive/`: sizes from 21 bytes for
   empty tables — binary COPY's signature+header — up to 6539 bytes for
   `Transaction`); confirmed programmatically too via `VERIFY_OK`.
4. **`pg_restore --list` equivalent** — no real archive-format file exists
   to list (COPY-binary per table, not a single `pg_restore`-readable
   archive), so the equivalent here is the manifest's per-table
   row/byte-size table of contents, enumerated above — functionally the
   same information `pg_restore --list` would show for a `pg_dump -Fc`
   archive.
5. **Second, empty disposable database** — `backup_drill_restore` created
   fresh via the maintenance database.
6. **Restore** — schema applied first (`prisma migrate deploy`, all 10
   migrations, confirmed **"Database schema is up to date!"**), then all 25
   tables' data loaded via `COPY ... FROM STDIN (FORMAT binary)` with
   `session_replication_role = replica` to defer FK/trigger ordering during
   the bulk load, restored to `DEFAULT` immediately after.
7. **Verify row counts and relationships** — **all 25/25 tables matched
   exactly** (`ROW_COUNTS`, every entry `"match":true`); **zero** orphaned
   transactions (`Transaction ⋈ BankAccount` LEFT JOIN with no match); a
   live 3-way spot check — `Budget ⋈ Category` join returned real linked
   names (`"Groceries"→"Groceries"`, `"Drill Budget"→"Drill Category"`,
   etc.), zero accounts with a `NULL` balance, and **zero**
   `Transaction.userId`/`BankAccount.userId` ownership mismatches across
   any restored row.
8. **`prisma migrate status`** — **"Database schema is up to date!"** on
   the restored database, same 10-migration count as the source.
9. **Health/integrity smoke queries** — the row-count/orphan/join checks
   above, plus the ownership-mismatch and null-balance checks, all against
   the *restored* database, not the source — proving the restore produced a
   database the application could actually run against, not just a
   byte-identical file.

**Rollback-decision guidance** (documented here and in
`docs/BACKUP_RESTORE.md`): a restore is only ever performed into a **new**
database, never in-place over a live one — the decision to roll back a
production deploy is "point the app at the last-known-good backup restored
into a freshly created database, then re-point once verified," never "restore
over the existing production database." This drill exercised exactly that
shape (fresh DB in, verify, only then would traffic ever be re-pointed).
**Production was never touched at any point in this drill** — every
connection string used throughout points at `localhost:5433`, the disposable
instance.

`INTEGRITY_CHECK_PASSED` — same clean result as the original drill, now
re-verified explicitly against this round's exact requested step sequence.
The drill's disposable databases (`backup_drill_restore` and the drill's
seed rows in `direct_banking_test`) were left on the local disposable
Postgres instance for evidence continuity; the seed rows were removed after
verification (`user.deleteMany` on the drill's tagged email, cascades
cleanly) so they don't linger in the shared test database going into the
final gate run.

## 27. Regression test coverage added this pass, and one real fix found while writing it

Beyond the migration rehearsal and index audit above, this pass added
regression coverage the earlier round didn't have, and fixed one genuine
(minor) gap found in the process:

- **`accounts.routes.ts`'s PROVIDER-balance manual-edit guard** had no
  dedicated test until now — it was added in round 1 but only exercised
  incidentally. New file
  `packages/server/src/routes/phase6-web-account-guard.test.ts` builds a
  small, focused cookie-session HTTP harness (register via `/api/auth/register`,
  capture the session cookie + CSRF token, use them on subsequent requests)
  — a separate file so its two `/auth/*` calls don't compete with
  `phase6-security.test.ts`'s already-budgeted rate-limiter allowance. Covers
  all three required scenarios: LEDGER + owner → allowed; PROVIDER + owner →
  `409`, balance untouched; different user → `404` (ownership check runs
  before the balance-authority check, so an attacker can't even confirm the
  account exists). A fourth case was added for clarity: editing a
  PROVIDER account's *non-balance* field (nickname) is still allowed — the
  guard is scoped to `balanceMinor` specifically, not the whole account.
- **Auth/ownership gaps closed**: an invalid/garbage refresh token (one that
  was never issued at all — distinct from expired, revoked, or reused)
  correctly returns `{ ok: false, reason: "invalid" }`; cross-user attempts
  against statement `/preview`, `/parse`, and `/import` (not just the plain
  `GET`) all `404`; a cross-user `/internal-transfers/unpair` attempt is
  rejected and leaves the owner's transfer pairing intact.
- **Input/parser fuzzing extended**: wrong/unsupported declared file type
  (`400`), empty file (`400`), syntactically invalid base64 (decodes
  leniently per Node's `Buffer.from` rather than throwing, so the real
  assertion is that whatever comes out is still handled safely — either a
  clean `400` or a `FAILED` import, never a crash), a CSV with a mix of
  valid and invalid rows (bad date / non-numeric amount / zero amount) —
  confirmed the parser **silently skips** each invalid row rather than
  inventing data or crashing, importing only the well-formed rows, oversized
  pagination limits clamp to the configured maximum (`200`) rather than
  erroring, and a path-traversal-style filename (`../../../../etc/passwd.csv`)
  is confirmed sanitised (`/` and `\` stripped) rather than used as a real
  path anywhere.
- **Formula-injection coverage confirmed for both CSV exporters** — no gap
  found. `phase5.test.ts` already covers the Phase 5/mobile exporter
  (`export.service.ts`'s `exportTransactionsCsv`) and `phase6.test.ts`
  already covers the legacy exporter (`reports.service.ts`'s
  `transactionsCsv`); both assert the leading-`=`/`@` neutralisation. Nothing
  added here — both were already tested.

**Real (minor) gap found and fixed**: fuzzing an unrecognised enum value
into `/activity`'s `direction`/`type`/`source`/`status` query-string filters
(e.g. `?direction=NOT_A_REAL_DIRECTION`) surfaced a Prisma validation error
that the generic error handler *did* catch safely — no crash, no stack
trace in the response, per the invariant this whole section is checking —
but it came back as an uninformative `500` rather than a proper `400`,
because the route cast the raw query string straight into the Prisma filter
without validating it first. **Fixed**: `mobile.routes.ts`'s `/activity`
route now validates `direction`, `type`, `source`, and `status` against
explicit whitelists before they ever reach Prisma, returning a clean `400`
for any unrecognised value. Covered by a new test asserting all four filters
now `400` correctly. This was a genuinely small, targeted fix — not a
redesign — closing exactly the class of gap this section's fuzzing exists to
find.

All additions confirmed green: `phase6-security.test.ts` →
**31/31 passed**; `phase6-web-account-guard.test.ts` → **4/4 passed**;
server typecheck clean after the `/activity` route change.
