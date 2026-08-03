// Money is handled in integer pence; UK/GBP formatting by default.

export function formatMoney(minor: number, currency = "GBP", locale = "en-GB"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format((minor ?? 0) / 100);
}

export function formatSignedMoney(minor: number, direction: "INCOME" | "EXPENSE" | "TRANSFER", currency = "GBP"): string {
  const sign = direction === "EXPENSE" ? "-" : direction === "INCOME" ? "+" : "";
  return `${sign}${formatMoney(Math.abs(minor), currency)}`;
}

export function toMinor(input: string): number {
  const raw = input.trim().replace(/[,\s£$€]/g, "");
  if (raw === "" || raw === "-") return 0;
  if (!/^-?\d*(\.\d+)?$/.test(raw)) throw new Error("Invalid amount");
  const negative = raw.startsWith("-");
  const [whole, frac = ""] = raw.replace("-", "").split(".");
  const pence = Number(whole || "0") * 100 + Number((frac + "00").slice(0, 2));
  return negative ? -pence : pence;
}

export function formatDateUK(value: string | Date, locale = "en-GB"): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

export function formatDateTimeUK(value: string | Date, locale = "en-GB"): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
}

export function formatMonthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { month: "short", year: "2-digit" }).format(new Date(Date.UTC(y!, (m ?? 1) - 1, 1)));
}

/** Today's date as yyyy-mm-dd for date inputs. */
export function todayInput(): string {
  return new Date().toISOString().slice(0, 10);
}
