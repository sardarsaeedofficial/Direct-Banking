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
export const NEVER_SEND_FIELDS = new Set([
  "accesstoken", "refreshtoken", "providerconnectionidencrypted", "opendata_key",
  "jwt", "password", "passwordhash", "csrfsecret", "sessionsecret",
  "twofactorsecret", "totp", "authorization", "cookie", "databaseurl",
  "plaid_secret", "plaidsecret", "smtp_pass",
]);

/** Defensive guard: throws if a candidate payload accidentally carries a
 *  forbidden key, so a future refactor that widens the input object can
 *  never silently leak a secret to an AI provider. */
export function assertNoForbiddenFields(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (NEVER_SEND_FIELDS.has(key.toLowerCase())) {
      throw new Error(`Refusing to send forbidden field "${key}" to an AI provider`);
    }
  }
}
