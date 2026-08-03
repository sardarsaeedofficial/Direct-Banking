# Direct Banking

A personal **direct-debit, income, expenditure and cashflow** management application.

Direct Banking **records and forecasts** your money — it is **not a bank and never moves money**. It tracks transactions, predicts future recurring payments, sends reminders, and produces monthly and yearly financial reports.

> Default currency **GBP**, UK date formatting. Other currencies are supported per account.

---

## Features

- **Dashboard** — income & expenditure this month, expected vs paid direct debits, safe-to-spend, expected end-of-month balance, upcoming payments, monthly & yearly charts, spending by category and by account, recurring subscriptions, and unusual-activity detection.
- **Bank accounts** — nickname, type, last-four, currency, manually-entered balance, colour. *No login credentials, PINs, security answers or full card numbers are ever stored.*
- **Recurring payments** — direct debit, standing order, subscription, recurring card, rent, loan, insurance, council tax, manual. Future expected payments are generated **without overwriting history**.
- **Transactions** — income/expenditure, pending/completed/refunded/cancelled, manual entry, CSV import, notification import, categories, tags, notes, split transactions, transfers, refunds, merchant normalisation, duplicate detection, search & filters.
- **Recurring detection** — suggests patterns and alerts on amount changes, early/late/missing payments, duplicates, and possible new subscriptions.
- **Calendar & forecasting** — timeline, projected daily balance, minimum balance required, 7/14/30-day forecasts.
- **Reminders** — configurable days-before, in-app + email + browser-push-ready, delivered by a **database-driven scheduled checker that survives restarts** and never sends duplicates.
- **Imports** — CSV wizard with column mapping, preview, duplicate checks, import history and **batch rollback**, plus a notification-import review queue (low-confidence items are never auto-trusted).
- **Reports** — monthly & yearly summaries, category/merchant/account/recurring reports, income vs expenditure, downloadable CSV, print-friendly.
- **Security** — scrypt password hashing, HTTP-only secure cookies, CSRF (double-submit), rate limiting, Zod validation, Prisma parameterised access, audit logs, session expiry, optional TOTP two-factor, redacted logs, and no secrets in Git.

---

## Tech stack

TypeScript · React + Vite · Node.js + Express · PostgreSQL · Prisma · Tailwind CSS · Recharts · Zod · secure cookie auth · PWA · pnpm.

The frontend is built and its static files are copied into the Express server's `public/` directory. **One production Node process** serves the SPA at `/`, the API under `/api`, and returns `index.html` for unknown frontend routes (SPA routing).

## Project layout

```
direct-banking/
├── prisma/                 # schema.prisma (15 models) + dev seed
├── packages/
│   ├── shared/             # Zod schemas, enums, money/date helpers
│   ├── server/             # Express + Prisma; serves API and built SPA
│   │   └── public/         # ← built frontend is copied here
│   └── web/                # React + Vite + Tailwind + Recharts PWA
└── scripts/copy-web.ts     # copies web/dist → server/public
```

---

## Local development

**Prerequisites:** Node ≥ 20, pnpm, and a PostgreSQL database.

```bash
pnpm install --frozen-lockfile
cp .env.example .env            # then edit DATABASE_URL and SESSION_SECRET
pnpm prisma:generate
pnpm db:migrate:dev             # create the schema in your database
pnpm db:seed                    # OPTIONAL: dev-only sample data (see below)
pnpm dev                        # API on :8080, Vite dev server on :5173 (proxies /api)
```

Open http://localhost:5173.

### Development seed (never runs in production)

`pnpm db:seed` creates a demo user with realistic data, including the **Helifica** example from the spec (£85, Monzo, monthly, day 20, remind 5 days before):

```
Login: demo@direct-banking.local  /  demopassword1
```

Production routes never use mock data — sample data exists only in this separate seed command.

---

## Production build & run

```bash
pnpm install --frozen-lockfile
pnpm run build      # prisma generate → build shared → build web → build server → copy web into server/public
pnpm start          # single Node process, listens on $PORT
```

- **Port:** `process.env.PORT`
- **Health:** `GET /api/healthz` → `{ status, db, time }` (503 if the database is unreachable)
- **Route mode:** `fullstack_node` (API + frontend from one process)

Run database migrations against your production database before first start:

```bash
pnpm db:migrate     # prisma migrate deploy
```

---

## Deploying on Prism

Direct Banking is designed to deploy as a single **`fullstack_node`** service on the Prism panel.

**Panel settings**

| Setting | Value |
| --- | --- |
| Route mode | `fullstack_node` |
| Install command | `pnpm install --frozen-lockfile` |
| Build command | `pnpm run build` |
| Start command | `pnpm start` |
| Port | `process.env.PORT` (set by the panel) |
| Health check | `GET /api/healthz` |

**Required environment variables** (set in the panel, never committed):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Long random string for session/CSRF secrets |
| `COOKIE_SECURE` | `true` when served over HTTPS |
| `PORT` | Provided by the panel |
| `SESSION_TTL_DAYS` | Session lifetime (default 7) |
| `SCHEDULER_INTERVAL_SECONDS` | Reminder poll interval (default 60) |
| `SMTP_*` | Optional — for email reminders |

**Steps**

1. Provision a PostgreSQL database and set `DATABASE_URL`.
2. Deploy with the install/build/start commands above.
3. On first deploy (or after schema changes) run `pnpm db:migrate` against the database.
4. The panel serves the app at `/`, the API at `/api`, and health-checks `/api/healthz`.

Because the build copies the compiled frontend into the server's `public/` directory, the panel only ever starts **one** Node process — it never starts the API while leaving the frontend unserved.

---

## Testing

```bash
pnpm test           # Vitest across packages (money maths, recurrence engine, password hashing)
```

---

## Security notes

- Passwords are hashed with **scrypt** (Node built-in; salted, constant-time verification).
- Sessions are stored server-side; only a **hash** of the cookie token is persisted.
- All mutating requests require a matching **CSRF** token (double-submit cookie + header).
- Requests are validated with **Zod**; all database access is parameterised via **Prisma**.
- Logs **redact** passwords, tokens, secrets and 2FA material.
- The data model has **no fields** for bank credentials, PINs, security answers or full card numbers.
```
