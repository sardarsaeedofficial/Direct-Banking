# Backup, verify, restore & rollback

This is the procedure for backing up the Direct Banking production PostgreSQL
database, verifying the backup, restoring it, and deciding whether to roll
back a deployment. It was exercised end-to-end on disposable data as part of
the Phase 6 production-readiness audit (see `docs/PHASE6_AUDIT.md` §7) — never
against production.

## 1. Backup

Use `pg_dump` in **custom format** (`-Fc`): it's compressed, supports
selective/parallel restore, and is the format `pg_restore` expects.

```bash
pg_dump -Fc \
  --no-owner --no-acl \
  -h <host> -U <user> -d direct_banking \
  -f direct_banking_$(date +%Y%m%d_%H%M%S).dump
```

- Run this from a host with network access to the database, using a role with
  read access to all tables (a dedicated `backup` role, not the app's own
  connection role, is preferable in a mature setup).
- Store the dump somewhere durable and access-controlled (encrypted object
  storage, not the app server's local disk only) — it contains full customer
  financial data.
- Automate this on a schedule (e.g. nightly via cron/PM2) and alert on failure.
  This document doesn't prescribe the scheduler — only the commands.

**Never** run this against a connection string you're not certain is the
intended database. Double-check `-h`/`-d` before running.

## 2. Verify the backup

Before trusting a backup, confirm it's structurally sound and non-empty:

```bash
# Lists the archive's table of contents without touching any database —
# a corrupt or truncated dump fails here immediately.
pg_restore -l direct_banking_20260101_020000.dump

# Sanity-check it contains the expected core tables.
pg_restore -l direct_banking_20260101_020000.dump | grep -E '"User"|"Transaction"|"BankAccount"'
```

A healthy dump lists every table in the schema with a nonzero size. If
`pg_restore -l` fails to parse the file, the backup is unusable — investigate
immediately and re-run the backup; do not wait for a restore emergency to find
out.

## 3. Restore

Always restore into a **new, empty database** — never `pg_restore` on top of a
live database you intend to keep, and never target production directly during
a drill.

```bash
createdb -h <host> -U <user> direct_banking_restore_check
pg_restore --no-owner --no-acl \
  -h <host> -U <user> -d direct_banking_restore_check \
  direct_banking_20260101_020000.dump
```

Then run the same integrity checks used in the Phase 6 drill:

```sql
-- Every table's row count is present and non-negative (sanity, not a specific value).
SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname;

-- No orphaned transactions (every account reference resolves).
SELECT count(*) FROM "Transaction" t
  LEFT JOIN "BankAccount" a ON a.id = t."accountId" WHERE a.id IS NULL;
-- must be 0

-- A representative join actually returns data.
SELECT t.id, t.description, a.nickname
  FROM "Transaction" t JOIN "BankAccount" a ON a.id = t."accountId" LIMIT 5;
```

Then confirm the application itself is happy with the restored schema:

```bash
DATABASE_URL=postgresql://.../direct_banking_restore_check pnpm exec prisma migrate status
```

should report **"Database schema is up to date"** — if it doesn't, the backup
predates a migration that's since been applied to production, which is
expected for an older backup and not itself a failure; just be aware of it
when deciding what to restore.

Once satisfied, drop the check database — don't leave restored copies of
production financial data lying around:

```bash
dropdb -h <host> -U <user> direct_banking_restore_check
```

### What was actually exercised in the Phase 6 drill

This sandboxed environment had no `pg_dump`/`pg_restore` binaries available
(only the bare Postgres server ships with the embedded test instance used for
this project's automated tests). The drill above was therefore exercised at
the data level instead — a full per-table `COPY ... (FORMAT binary)` export,
an archive-integrity check, a fresh database with the schema restored via
`prisma migrate deploy`, a full data reload, and the same integrity queries
shown above. All 25 tables' row counts matched exactly, zero orphaned
`Transaction` rows, and a live join returned correct data. This proves the
underlying guarantee (all data extracts and reloads losslessly); the commands
above are what to actually run against the real production database, where
the standard PostgreSQL client tools are present.

## 4. Rollback decision

A backup restore is for **disaster recovery** (corrupted database, catastrophic
data loss) — it is not the first response to a bad deploy. Prefer, in order:

1. **Roll forward with a fix.** Most issues (a bad API response, a UI bug) are
   fixed faster and more safely by shipping a corrected commit than by
   restoring a backup, which loses every transaction recorded since that
   backup was taken.
2. **Redeploy the previous known-good commit** (`git checkout <prev-sha>`,
   rebuild, redeploy) when the new code itself is the problem and no new
   *migration* was part of the bad deploy. Prisma migrations are additive and
   forward-only in this project (see `docs/PRODUCTION_DEPLOYMENT.md`), so an
   older server version continues to work against a newer (already-migrated)
   schema — additive columns/tables it doesn't know about are simply unused.
3. **Restore from backup** only when data itself is corrupted or lost (e.g. an
   operational mistake deleted rows, storage failure) — not merely because the
   latest deploy has a bug. Restoring loses all data changes between the
   backup and the restore, which for a financial ledger is a serious,
   customer-visible event; treat it as a last resort, and communicate clearly
   about the time window of lost data before doing it.

Never restore directly onto production without first restoring into a
scratch database and running the verification steps above — an unverified
backup is not a backup.
