# Open Banking (Plaid) — configuration & runbook

Direct Banking's Open Banking integration is provider-pluggable (TrueLayer and
Plaid are both implemented against a shared `BankDataProvider` interface). This
document covers **Plaid**, the fully transaction-capable provider, and is
written for **Sandbox** use. **Plaid production is not enabled by this
document or by any default in the codebase.**

## Default production safety

```
OPEN_BANKING_ENABLED=false
```

is the default (see `packages/server/src/env.ts`) — Open Banking stays fully
disabled, and the rest of the app (notification capture, statement import,
manual entry, insights, budgets) works exactly as if it were never built,
until an operator explicitly configures and enables it.

## Required environment variables (Sandbox)

Set these on the **backend server only** — never in the Android app, never in
any client-visible config:

```
OPEN_BANKING_ENABLED=true
OPEN_BANKING_PROVIDER=plaid
PLAID_ENV=sandbox
PLAID_CLIENT_ID=<from the Plaid dashboard>
PLAID_SECRET=<the SANDBOX secret from the Plaid dashboard>
PLAID_WEBHOOK_URI=https://<your-backend-host>/api/mobile/v1/bank-connections/webhook/plaid
OPEN_BANKING_DATA_KEY=<32-byte key, hex or base64 — generate with `openssl rand -hex 32`>
BANK_SYNC_CRON=*/15 * * * *
```

- `PLAID_CLIENT_ID` / `PLAID_SECRET` come from the Plaid dashboard's Team
  Settings → Keys page. Use the **Sandbox** secret for this runbook — never
  the Production secret in a non-production environment.
- `OPEN_BANKING_DATA_KEY` encrypts every provider connection secret
  (including Plaid's `access_token`) at rest with AES-256-GCM before it's
  written to `BankConnection.providerConnectionIdEncrypted`. Generate a fresh
  one per environment; losing it makes existing connections unrecoverable
  (they'd need to be reconnected, not decrypted).
- `BANK_SYNC_CRON` controls the scheduled background sync interval (standard
  cron syntax); omit it to disable the scheduler and sync only on-demand.

### Confirmed backend-only, never reaching the client

- **`PLAID_SECRET`** is read once in `env.ts`, passed only into the Plaid
  provider's own HTTP client construction — never returned in any API
  response, never logged (see `docs/PHASE6_AUDIT.md` §8).
- **`OPEN_BANKING_DATA_KEY`** is used only inside `crypto.ts`'s
  encrypt/decrypt functions — never serialised, never sent to a client.
- **`access_token`** (Plaid) / the provider connection id (TrueLayer) is
  encrypted immediately on receipt (`encryptJson(...)` before every write to
  `BankConnection.providerConnectionIdEncrypted`) and is never included in any
  mobile API response — the Android app only ever receives a `connectionId`
  (Direct Banking's own id) and, transiently during the Link flow, a
  short-lived `linkToken` (Plaid's own ephemeral token, not the access token).

## Registering the Android app with Plaid

Plaid's Link SDK on Android requires the app's package name to be allow-listed
in the Plaid Dashboard before Link will complete a real connection (Sandbox
included):

1. Plaid Dashboard → **Developers → API** (or **Link** settings, depending on
   dashboard version) → **Allowed Android package names**.
2. Add: `uk.co.prisom.directbanking`
   - Also add the **debug** build's applicationId if you test with debug
     builds: `uk.co.prisom.directbanking.debug` (the debug build type appends
     `.debug` — see `android/app/build.gradle.kts`).
3. Save. Changes can take a few minutes to propagate.

Without this, Plaid Link on Android fails to open/complete even with valid
Sandbox credentials.

## Disabling Open Banking instantly

Set `OPEN_BANKING_ENABLED=false` (or unset it — it defaults to `false`) and
restart the backend. This is a single environment-variable flip:

- No code path anywhere gates on anything else to decide whether Open Banking
  is active — `registry.ts` only constructs/returns a provider when
  `OPEN_BANKING_ENABLED` is true.
- Existing `BankConnection`/`BankAccount` rows and their transaction history
  are **not deleted** — they simply stop syncing. Re-enabling later resumes
  where the stored `syncCursor` left off.
- No migration, no data loss, no user-visible error — the app behaves as the
  notification/statement-only app it was before Open Banking was configured.

## Sandbox test plan (§10)

This is a manual test plan requiring a real Plaid Sandbox account — the
automated test suite (`plaid-provider.test.ts`, `plaid.integration.test.ts`,
`open-banking.integration.test.ts`) already covers the reconciliation/sync
logic itself against a **mocked** provider so CI needs no real credentials.
Run this plan whenever Plaid Sandbox credentials change or before any Plaid
production request:

1. **Create a Link token** — `POST /api/mobile/v1/bank-connections/start`
   with a valid mobile bearer token. Confirm the response has
   `mode: "link_token"` and a non-empty `linkToken`.
2. **Open Plaid Link** on the Android app (or Plaid's Link demo web page
   pointed at the same `link_token` for a quicker manual check) and select a
   Sandbox institution (e.g. "Platypus Bank" / `ins_109508` in Plaid's
   Sandbox catalogue).
3. **Complete the Sandbox login** using Plaid's documented Sandbox
   credentials (`user_good` / `pass_good` for the default test institution).
4. **Exchange `public_token`** — the app calls
   `POST /api/mobile/v1/bank-connections/:id/complete`; confirm it returns
   `200` and the connection's `status` becomes `ACTIVE`.
5. **Confirm a `BankConnection` row was created** with
   `providerConnectionIdEncrypted` populated (encrypted, not the raw
   `access_token`) and `provider = "plaid"`.
6. **Import accounts** — `GET /api/mobile/v1/bank-connections/:id` should list
   the Sandbox institution's accounts with masked identifiers only.
7. **Import balances** — each account's balance should be populated and its
   `balanceAuthority` should be `PROVIDER`.
8. **Initial transactions sync** — trigger
   `POST /api/mobile/v1/bank-connections/:id/sync`; confirm transactions
   appear in Activity and `BankConnection.syncCursor` is now non-null.
9. **Cursor persistence** — call sync again immediately; confirm it completes
   quickly with `imported: 0` (no duplicates) because the stored cursor
   prevents re-fetching the same history.
10. **Subsequent sync** — use Plaid's Sandbox `/sandbox/item/fire_webhook`
    (or wait for `BANK_SYNC_CRON`) to simulate new activity, then confirm the
    scheduler or manual sync picks it up.
11. **Webhook-triggered sync** — confirm `PLAID_WEBHOOK_URI` is reachable
    from Plaid (a public HTTPS URL — use a tunnel like ngrok for local
    testing) and that a webhook call triggers a sync without manual action.
12. **Duplicate webhook** — send the same webhook payload twice; confirm no
    duplicate transactions are created (idempotent on the provider
    transaction id / sync cursor).
13. **Modified transaction** — use Plaid Sandbox's transaction-modification
    tooling; confirm the existing canonical transaction is updated in place,
    not duplicated.
14. **Removed transaction** — confirm the canonical transaction is marked
    `CANCELLED` (balance safely reversed only if it had been applied) rather
    than deleted, preserving history.
15. **Notification + Plaid reconciliation** — if the same real-world payment
    also arrives via a captured notification, confirm it converges to **one**
    canonical transaction with two `TransactionEvidence` rows, not two
    transactions (covered by an automated test with a mocked provider in
    `phase5.test.ts`; repeat manually against real Sandbox data as a final
    check).

None of the above requires real banking credentials — Plaid Sandbox is
entirely synthetic. **Do not** point `PLAID_ENV` at `production` or use a
production `PLAID_SECRET` while following this runbook.

## Production approval requirements (not covered by this document)

Moving from Sandbox to Plaid Production requires, at minimum: Plaid's
production access approval process for your use case, a production
`PLAID_CLIENT_ID`/`PLAID_SECRET` pair, re-registering the Android package name
for the Production environment in the Plaid dashboard, a publicly reachable
production `PLAID_WEBHOOK_URI` over HTTPS, and your own review of Plaid's data
use/compliance requirements for a financial app. This document intentionally
does not walk through that process — it is an account-level, human decision
outside what configuration alone can safely automate.
