# Statement import — formats, limitations & behaviour

Statement import (Phase 5) is the **fallback** transaction-import path for
banks where notification capture and Open Banking coverage aren't available,
or where a user needs to backfill history that predates connecting the app.
It's reachable from **Settings → Import bank statement** in the Android app.

## Supported formats

| Format | Notes |
|---|---|
| **CSV** | Auto-detects the header row and common UK/EU bank column layouts: a single signed `Amount` column, or separate `Debit`/`Credit` (also recognises "Paid out"/"Paid in", "Money out"/"Money in"). Dates are parsed UK day-first by default with several fallback formats. |
| **OFX** | Standard `<STMTTRN>` blocks; `TRNAMT` sign determines direction; `FITID` is used as a reference when present. |
| **QIF** | Standard Quicken fields: `D` date, `T`/`U` amount, `P` payee, `M` memo, `N` reference. |
| **Text-based PDF** | Only PDFs whose transaction rows can be extracted as real text (a `FlateDecode`-compressed or plain content stream with `Tj`/`TJ` text-drawing operators) — parsed with Node's built-in `zlib`, no external PDF library. A row is only accepted when it confidently contains **both** a parseable date and a parseable amount; a whole file is rejected if fewer than 3 such rows are found. |

## Explicitly unsupported: scanned/image PDFs

**Scanned or image-only PDF statements are not supported.** Direct Banking
does **not** perform OCR and never will as part of this import path — a
scanned statement has no text layer to extract, so the parser correctly
returns:

```
Unsupported statement format
```

rather than guessing at line items from image data. If a user's bank only
offers scanned PDF statements, the correct path is a CSV/OFX export from the
bank (nearly every UK bank offers one) or manual entry.

The same "reject rather than invent" rule applies to any file that doesn't
parse confidently — a handful of stray date-and-amount-looking substrings in
an otherwise unrelated document does not make it a valid statement (the PDF
parser specifically requires at least 3 confident rows).

## Deduplication

Three independent guards, all covered by automated tests:

1. **Same file uploaded twice** — `StatementImport` is unique on
   `(userId, accountId, fileHash)` (a SHA-256 of the uploaded bytes). Uploading
   identical bytes to the same account returns the **same** import session; no
   duplicate rows, no duplicate transactions.
2. **Overlapping statement date ranges** (e.g. two monthly statements that
   share a few days) — each parsed row gets a normalized fingerprint (date +
   signed amount + direction + cleaned description/reference, never the raw
   file text). A row whose fingerprint already has `TransactionEvidence` on
   the target account is flagged `DUPLICATE` and skipped on import — no second
   transaction is created.
3. **Retrying a failed/partial import request** — importing is idempotent per
   row: a `StatementCandidate` already marked `IMPORTED` is never re-created
   on a repeat `POST .../import` call.

## Review & account mapping

- **Account mapping is mandatory and never inferred**: the user must
  explicitly pick which existing `BankAccount` a statement belongs to before
  anything is parsed against the ledger. A statement is never auto-attached to
  an account based on a guess (e.g. matching the account name in the file).
- **Preview before commit**: parsing produces staged `StatementCandidate` rows
  only — nothing touches the ledger until the user reviews the preview (new /
  already-recorded / needs-review counts, with the ability to exclude
  individual rows) and explicitly confirms.
- **Uncertain matches** go to the Reconciliation Review Centre
  (Settings → Review) rather than being silently merged or silently created as
  duplicates.

## Balance behaviour

- **Historical import never silently changes an established balance.**
  Imported transactions default to `balanceApplied = false` — they're
  recorded in Activity/Insights but do not move `BankAccount.balanceMinor`.
  Rebuilding a balance from imported history is only ever an explicit,
  opt-in action, never the default.
- **`PROVIDER`-authoritative accounts** (linked via Open Banking) are never
  touched by statement import regardless of any option passed — this is
  enforced in `createTransaction()` itself (see `docs/PHASE6_AUDIT.md` §2.1),
  not just by the statement-import code path, so it holds even if a future
  caller forgets to opt out.
- Imported rows still run through the full classification pipeline
  (categorisation, merchant normalisation, Direct Debit detection,
  internal-transfer detection) exactly like a notification- or Plaid-sourced
  transaction — a statement-imported Direct Debit is recognised as a Direct
  Debit, an imported internal transfer is excluded from income/spending, etc.

## Limits

- Upload size is capped (`STATEMENT_MAX_BYTES`, default 5 MB) — an oversized
  upload is rejected with a clear `400`/`413`, never processed.
- The whole request body is capped at 6 MB (`express.json` limit) as a second,
  independent bound.
- Parsing happens entirely in memory — no uploaded file is ever written to
  disk, and the raw uploaded bytes are **not** persisted after parsing
  (`StatementImport` stores only metadata: filename, file type, hash, counts,
  period, status — never the file content).
