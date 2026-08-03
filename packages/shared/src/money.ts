// Money is represented as integer minor units (pence). These helpers convert to
// and from the major-unit strings that humans type and read.

/** Parse a user-entered major-unit string (e.g. "85", "85.50", "1,234.5") to pence. */
export function toMinor(input: string | number): number {
  const raw = typeof input === "number" ? input.toString() : input.trim().replace(/[,\s£$€]/g, "");
  if (raw === "" || raw === "-") return 0;
  if (!/^-?\d*(\.\d+)?$/.test(raw)) {
    throw new Error(`Invalid monetary amount: "${input}"`);
  }
  const negative = raw.startsWith("-");
  const [whole, frac = ""] = raw.replace("-", "").split(".");
  const pence = Number(whole || "0") * 100 + Number((frac + "00").slice(0, 2));
  return negative ? -pence : pence;
}

/** Convert pence to a major-unit number (e.g. 8500 -> 85). Use only for display maths. */
export function toMajor(minor: number | bigint): number {
  return Number(minor) / 100;
}

/** Format pence as a localized currency string, defaulting to GBP / en-GB. */
export function formatMoney(
  minor: number | bigint,
  currency = "GBP",
  locale = "en-GB",
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(Number(minor) / 100);
}

/** BigInt-safe absolute value. */
export function absMinor(minor: bigint): bigint {
  return minor < 0n ? -minor : minor;
}
