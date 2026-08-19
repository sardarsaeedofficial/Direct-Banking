# Production deployment runbook

The exact, safe sequence for deploying a new Direct Banking backend release.
**Never includes credentials** — every value referenced here lives in your
own secrets store / environment configuration, never in this document or in
the repository.

## Prerequisites

- A reachable production PostgreSQL 16 instance, already running the prior
  release's schema.
- The production `.env` (or equivalent secret store) already has real values
  for at minimum: `DATABASE_URL`, `SESSION_SECRET`, `MOBILE_JWT_SECRET` (both
  **must** be overridden from their insecure development defaults — see
  `packages/server/src/env.ts`), and, if Open Banking is in use,
  `OPEN_BANKING_DATA_KEY`/`PLAID_SECRET`/etc. (see `docs/OPEN_BANKING.md`).
- PM2 (or your process manager of choice) already managing the running
  `project-direct-banking` process.

## The sequence

### 1. Pull the final `main`

```bash
git fetch origin --prune
git checkout main
git pull --ff-only origin main
```

### 2. Verify the commit

```bash
git log -5 --oneline
```

Confirm the commit at `HEAD` is the one you intend to deploy — cross-check
against the Release Candidate identified in the relevant phase report (e.g.
`docs/PHASE6_AUDIT.md`).

### 3. Confirm you're pointed at the production database

```bash
echo "$DATABASE_URL" | sed -E 's#(://[^:]+:)[^@]+(@)#\1***\2#'   # sanity-check host/db name only, never print the password
```

Double, triple check the **host** and **database name** before continuing.
Every step below is safe and additive by design, but confirming you're
targeting the right database is still the single most important manual check
in this whole runbook.

### 4. Backup

```bash
pg_dump -Fc --no-owner --no-acl -h <host> -U <user> -d direct_banking \
  -f direct_banking_$(date +%Y%m%d_%H%M%S).dump
```

See `docs/BACKUP_RESTORE.md` for the full backup/verify/restore/rollback
procedure. **Do not skip this step**, even for a release you're confident in.

### 5. Verify the backup

```bash
pg_restore -l direct_banking_<timestamp>.dump | grep -E '"User"|"Transaction"|"BankAccount"'
```

A healthy dump lists the core tables. If this fails, stop — re-run the backup
before proceeding. Full verification procedure: `docs/BACKUP_RESTORE.md`.

### 6. Install dependencies & generate the Prisma client

```bash
pnpm install --frozen-lockfile
pnpm exec prisma generate
```

### 7. Check migration status (before applying anything)

```bash
pnpm exec prisma migrate status
```

Review the list of pending migrations. Every migration in this repository's
history is additive (new tables/columns/indexes only — confirmed for every
phase through Phase 6 in `docs/PHASE6_AUDIT.md` §7). If you ever see a
migration that looks destructive (a `DROP`/`ALTER COLUMN ... TYPE` narrowing a
column, etc.), **stop and investigate before proceeding** — that would be a
deviation from this project's migration policy.

### 8. Apply migrations

```bash
pnpm exec prisma migrate deploy
```

**Never** run `prisma migrate reset`, `prisma db push`, `pnpm db:reset`, or
`pnpm db:seed` against production — `migrate deploy` is the only command this
runbook ever recommends for a production database.

### 9. Re-check migration status

```bash
pnpm exec prisma migrate status
```

Confirm it now reports **"Database schema is up to date."**

### 10. Build & deploy the application

```bash
pnpm run build
pm2 restart project-direct-banking --update-env
```

(Or your platform's equivalent zero/rolling-restart mechanism — the key
requirement is that `--update-env`, or your platform's equivalent, picks up
any new/changed environment variables from step 0's secrets configuration.)

### 11. Health check

```bash
curl -sf https://<your-backend-host>/api/healthz
```

Expect `{"status":"ok","db":"up",...}` with HTTP `200`. If it returns `503`
(`"status":"degraded"`), the process is up but can't reach the database —
investigate before considering the deploy successful.

### 12. Auth endpoint check

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<your-backend-host>/api/mobile/v1/auth/login \
  -H 'content-type: application/json' -d '{"email":"nonexistent@example.com","password":"wrongpassword","device":{"deviceId":"deploy-check","platform":"android"}}'
```

Expect `401` (not `500`/`502`/a connection error) — confirms the mobile auth
route is live, validating requests, and reaching the database, without using
any real credentials.

### 13. `pm2 save`

```bash
pm2 save
```

Persists the current process list so it survives a host reboot.

## Rollback guidance

See `docs/BACKUP_RESTORE.md` §4 for the full decision tree. Summary:

1. **Prefer rolling forward** with a fix over rolling back.
2. **Redeploy the previous commit** (`git checkout <prev-sha>`, repeat steps
   6/10–13) if the new *code* is the problem and no migration needs undoing —
   safe because every migration is additive, so an older server version keeps
   working against the newer (already-migrated) schema.
3. **Restore from backup** only for actual data loss/corruption — never as
   the first response to "the new deploy has a bug." Restoring loses every
   transaction recorded since the backup.

## Account deletion (final-release-completion round)

`DELETE /api/mobile/v1/me` permanently deletes the authenticated user's
account. This is a genuine, irreversible, user-initiated action — there is no
operator-side "undo" short of restoring from a pre-deletion backup (see
`docs/BACKUP_RESTORE.md`), which loses every account's activity since that
backup, not just the deleted user's.

- **Requires** the caller's current password (re-verified server-side — a
  leaked/short-lived access token alone cannot delete the account) and the
  exact literal request body `{"confirm":"DELETE"}`, both enforced by
  `mobileDeleteAccountSchema` independent of whatever the Android client
  displays.
- **Cascades** every row the schema attributes to that user (`onDelete:
  Cascade` on all 22 required `User` relations in `prisma/schema.prisma` —
  see `deleteUserAccount()` in `packages/server/src/services/users.service.ts`
  for the full audit) in one atomic `user.delete()`. The one deliberate
  exception is `AuditLog`, whose `User` relation is `onDelete: SetNull` — audit
  rows survive anonymised (`userId` set to `null`) rather than being deleted, a
  pre-existing, documented retention decision.
- **Revokes provider connections first, best-effort**: if the user has any
  active Plaid/TrueLayer `BankConnection`, `deleteUserAccount()` calls the
  provider's own revoke endpoint before deleting the row — once the row (and
  its encrypted access token) is gone, Direct Banking has no way to ever
  revoke it again, so this is the last chance. A provider failure here never
  blocks the deletion itself.
- **Session invalidation is automatic, not a separate step**: `MobileDevice`
  and `MobileRefreshToken` cascade away with the user, so `requireMobileAuth`
  (which does a live `MobileDevice` lookup on every request) rejects any
  further request from the deleted account's access token with `401` even
  before the token's own expiry — including a retry of the delete call
  itself.
- No migration was required for this feature — the cascade behaviour already
  existed in the schema from earlier phases; this round only added the
  route/service/tests that exercise it deliberately end-to-end (see
  `packages/server/src/routes/account-deletion.integration.test.ts`).

## Operational checks (PM2)

```bash
pm2 status                          # process up/down, restart count, uptime
pm2 logs project-direct-banking     # tail recent logs (redacted by design — docs/PHASE6_AUDIT.md §8)
pm2 save                            # persist the process list across reboots
```
