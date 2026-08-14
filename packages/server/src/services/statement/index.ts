import { parseCsv } from "./csv.js";
import { parseOfx } from "./ofx.js";
import { parseQif } from "./qif.js";
import { parsePdf } from "./pdf.js";
import { rowFingerprint, UnsupportedStatementError, type ParseResult } from "./normalise.js";

export type StatementFileType = "CSV" | "OFX" | "QIF" | "PDF";
export { UnsupportedStatementError } from "./normalise.js";
export type { ParsedRow, ParseResult } from "./normalise.js";

const EXT: Record<string, StatementFileType> = {
  csv: "CSV",
  tsv: "CSV",
  txt: "CSV",
  ofx: "OFX",
  qfx: "OFX",
  qif: "QIF",
  pdf: "PDF",
};

/** Resolve a file type from an explicit type or the filename extension. */
export function resolveFileType(declared: string | null | undefined, filename: string): StatementFileType | null {
  const d = declared?.toUpperCase();
  if (d === "CSV" || d === "OFX" || d === "QIF" || d === "PDF") return d;
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return EXT[ext] ?? null;
}

/**
 * Parse an uploaded statement into normalized rows with per-row fingerprints. Throws
 * UnsupportedStatementError when the format can't be parsed confidently (e.g. a
 * scanned/image PDF) — never invents transactions.
 */
export function parseStatement(fileType: StatementFileType, buf: Buffer): ParseResult & { rowsWithFingerprint: (import("./normalise.js").ParsedRow & { fingerprint: string })[] } {
  let result: ParseResult;
  switch (fileType) {
    case "CSV":
      result = parseCsv(buf.toString("utf8"));
      break;
    case "OFX":
      result = parseOfx(buf.toString("utf8"));
      break;
    case "QIF":
      result = parseQif(buf.toString("utf8"));
      break;
    case "PDF":
      result = parsePdf(buf);
      break;
    default:
      throw new UnsupportedStatementError();
  }
  const rowsWithFingerprint = result.rows.map((r) => ({ ...r, fingerprint: rowFingerprint(r) }));
  return { ...result, rowsWithFingerprint };
}
