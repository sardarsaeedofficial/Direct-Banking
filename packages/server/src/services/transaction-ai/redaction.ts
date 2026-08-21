// ---------------------------------------------------------------------------
// Privacy redaction — Transaction Intelligence Engine AI layer (§7)
//
// Strips/tokenises anything that must never reach an external AI provider
// before a classifierInputSchema payload is ever built. This runs on
// already-redacted notification text (NotificationImport.redactedText is
// itself already stripped of raw notification bodies — see
// notification-import.service.ts) — this is a SECOND, independent layer
// specifically for what leaves the server process, not a replacement for it.
// ---------------------------------------------------------------------------

const PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // Card/account numbers (13-19 digits, optionally space/dash separated) —
  // but NOT a 3-4 digit last-4 hint on its own (that's an intentional,
  // already-minimal accountHint field, not a full number).
  { re: /\b(?:\d[ -]?){13,19}\b/g, replacement: "[card-number-redacted]" },
  // UK sort code (NN-NN-NN).
  { re: /\b\d{2}-\d{2}-\d{2}\b/g, replacement: "[sort-code-redacted]" },
  // UK bank account number (bare 8 digits) — distinct from a card number (13-19
  // digits, matched above) and a sort code (6 digits with dashes, matched
  // above). Deliberately conservative: an 8-digit run is far more likely to
  // be a real account number than something legitimately useful to an AI
  // classifier, so it is always redacted even at the cost of an occasional
  // unrelated 8-digit reference number.
  { re: /\b\d{8}\b/g, replacement: "[account-number-redacted]" },
  // IBAN.
  { re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, replacement: "[iban-redacted]" },
  // Email addresses.
  { re: /\b[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}\b/g, replacement: "[email-redacted]" },
  // UK-style phone numbers.
  { re: /\b(?:\+44|0)\s?7\d{3}\s?\d{3}\s?\d{3}\b/g, replacement: "[phone-redacted]" },
  // Bearer tokens / JWTs / long opaque secrets that should never appear in
  // application text in the first place, but are stripped defensively —
  // JWTs (three base64url segments) and generic 32+ char hex/base64 blobs.
  { re: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: "[token-redacted]" },
  { re: /\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g, replacement: "[token-redacted]" },
  // Postcodes (UK) — coarse address-fragment redaction.
  { re: /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g, replacement: "[postcode-redacted]" },
];

/** Redact free text before it is ever included in an AI classifier input.
 *  Deliberately conservative — over-redacting is safe, under-redacting is not. */
export function redactForAi(text: string | null | undefined, maxLen = 600): string {
  if (!text) return "";
  let out = text;
  for (const { re, replacement } of PATTERNS) out = out.replace(re, replacement);
  return out.length > maxLen ? out.slice(0, maxLen) : out;
}

/** Field names that must NEVER be forwarded into an AI classifier input,
 *  defensively checked wherever a caller builds one from a broader object. */
// Entries are compared against normaliseFieldName()'s output below, which
// strips everything but lowercase letters/digits — so a single entry here
// (e.g. "databaseurl") matches "DATABASE_URL", "databaseUrl", "Database-Url",
// etc. regardless of the caller's naming convention. Keep every entry itself
// already in that normalised form.
export const NEVER_SEND_FIELDS = new Set([
  "accesstoken", "refreshtoken", "providerconnectionidencrypted", "opendatakey",
  "jwt", "password", "passwordhash", "csrfsecret", "sessionsecret",
  "twofactorsecret", "totp", "authorization", "cookie", "databaseurl",
  "plaidsecret", "smtppass",
  // The AI provider's OWN credential must never be echoed back into its own
  // input, however the caller happened to name the field. Covers both the
  // literal env var name and common object-key spellings of it.
  "apikey", "transactionaiapikey", "anthropicapikey", "claudeapikey", "providerapikey",
]);

/** Normalises a field name for comparison against NEVER_SEND_FIELDS,
 *  independent of naming convention (camelCase, snake_case, SCREAMING_SNAKE,
 *  PascalCase all collapse to the same key) so a caller can't accidentally
 *  dodge the guard just by spelling a forbidden field differently. */
function normaliseFieldName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Defensive guard: throws if a candidate payload accidentally carries a
 *  forbidden key, so a future refactor that widens the input object can
 *  never silently leak a secret to an AI provider. */
export function assertNoForbiddenFields(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (NEVER_SEND_FIELDS.has(normaliseFieldName(key))) {
      throw new Error(`Refusing to send forbidden field "${key}" to an AI provider`);
    }
  }
}
