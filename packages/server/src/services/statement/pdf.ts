import { inflateSync, inflateRawSync } from "node:zlib";
import { parseDate, parseMoneyToMinor, UnsupportedStatementError, type Direction, type ParsedRow, type ParseResult } from "./normalise.js";

// Confident text extraction from *text-based* PDFs only, using Node's built-in
// zlib to inflate FlateDecode content streams. NO OCR and NO image handling: a
// scanned/image PDF yields no text operators, so it is rejected as unsupported
// rather than guessed at.

/** Decode a PDF literal-string body (…) handling escapes and octal codes. */
function decodeLiteral(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      const n = body[i + 1];
      if (n === "n") out += "\n";
      else if (n === "r") out += "\r";
      else if (n === "t") out += "\t";
      else if (n === "(" || n === ")" || n === "\\") out += n;
      else if (n >= "0" && n <= "7") {
        const oct = body.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)?.[0] ?? "";
        out += String.fromCharCode(parseInt(oct, 8));
        i += oct.length;
        continue;
      } else out += n ?? "";
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

function decodeHex(body: string): string {
  const hex = body.replace(/\s+/g, "");
  let out = "";
  for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/** Turn one content stream into text lines, using text-positioning operators as breaks. */
function contentToText(content: string): string {
  let out = "";
  let i = 0;
  const n = content.length;
  // Track the last few tokens so we can detect line-move operators (Td/TD/T*/'/").
  while (i < n) {
    const c = content[i];
    if (c === "(") {
      // literal string until unescaped ')'
      let depth = 1;
      let j = i + 1;
      let body = "";
      while (j < n && depth > 0) {
        const cj = content[j];
        if (cj === "\\") {
          body += cj + (content[j + 1] ?? "");
          j += 2;
          continue;
        }
        if (cj === "(") depth++;
        else if (cj === ")") {
          depth--;
          if (depth === 0) break;
        }
        body += cj;
        j++;
      }
      out += decodeLiteral(body);
      i = j + 1;
    } else if (c === "<" && content[i + 1] !== "<") {
      const end = content.indexOf(">", i);
      if (end < 0) break;
      out += decodeHex(content.slice(i + 1, end));
      i = end + 1;
    } else if (c === "T" && (content[i + 1] === "*")) {
      out += "\n";
      i += 2;
    } else if ((c === "'" || c === '"')) {
      out += "\n";
      i += 1;
    } else if (c === "T" && (content[i + 1] === "d" || content[i + 1] === "D")) {
      out += "\n";
      i += 2;
    } else {
      i++;
    }
  }
  return out;
}

/** Extract text from all decodable content streams of a PDF buffer. */
function extractPdfText(buf: Buffer): string {
  const latin = buf.toString("latin1");
  let text = "";
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  let found = 0;
  while ((m = re.exec(latin)) !== null) {
    const start = m.index + m[0].length;
    const endIdx = latin.indexOf("endstream", start);
    if (endIdx < 0) continue;
    let raw = latin.slice(start, endIdx);
    // Trim a single trailing EOL that precedes endstream.
    raw = raw.replace(/\r?\n$/, "");
    const bytes = Buffer.from(raw, "latin1");
    const hasTextOps = (s: string) => /\bBT\b|\bTj\b|\bTJ\b/.test(s);
    let content: string | null = null;
    // Prefer a Flate-decoded stream, but only if it actually yields text operators —
    // raw inflate can emit garbage without throwing, so validate before trusting it.
    try {
      const d = inflateSync(bytes).toString("latin1");
      if (hasTextOps(d)) content = d;
    } catch {
      /* not zlib */
    }
    if (!content) {
      try {
        const d = inflateRawSync(bytes).toString("latin1");
        if (hasTextOps(d)) content = d;
      } catch {
        /* not raw deflate */
      }
    }
    if (!content && hasTextOps(raw)) content = raw; // uncompressed content stream
    if (content) {
      text += contentToText(content) + "\n";
      found++;
    }
  }
  if (found === 0) throw new UnsupportedStatementError();
  return text;
}

const AMOUNT_RE = /[-+(]?\s*[£$€]?\s*(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}(?:\s*(?:CR|DR))?\)?/gi;
const DATE_RE = /(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})|(\d{4}-\d{2}-\d{2})|(\d{1,2}\s+[A-Za-z]{3,4}\s+\d{2,4})/;

/**
 * Parse a text-based PDF statement. Only rows that confidently contain BOTH a date
 * and a money amount are accepted; if fewer than three such rows are found the file
 * is rejected as unsupported (rather than inventing transactions).
 */
export function parsePdf(buf: Buffer): ParseResult {
  const text = extractPdfText(buf);
  const lines = text
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const rows: ParsedRow[] = [];
  let minDate: Date | null = null;
  let maxDate: Date | null = null;

  for (const line of lines) {
    const dm = line.match(DATE_RE);
    if (!dm) continue;
    const bookedAt = parseDate(dm[0]);
    if (!bookedAt) continue;
    const amounts = line.match(AMOUNT_RE);
    if (!amounts || amounts.length === 0) continue;

    // The transaction amount is the first money token; a trailing one is the balance.
    const amt = parseMoneyToMinor(amounts[0]);
    if (!amt || amt.minor <= 0) continue;
    const balance = amounts.length > 1 ? parseMoneyToMinor(amounts[amounts.length - 1]) : null;

    // Description = the line with the date + amounts stripped out.
    let description = line.replace(dm[0], " ");
    for (const a of amounts) description = description.replace(a, " ");
    description = description.replace(/\s+/g, " ").trim() || "Statement transaction";

    const upper = line.toUpperCase();
    const direction: Direction =
      amt.sign < 0 || /\bDR\b/.test(upper) ? "EXPENSE" : /\bCR\b/.test(upper) ? "INCOME" : amt.sign < 0 ? "EXPENSE" : "INCOME";

    rows.push({
      rowIndex: rows.length + 1,
      bookedAt,
      amountMinor: amt.minor,
      currency: "GBP",
      direction,
      description,
      balanceAfterMinor: balance ? balance.minor * balance.sign : null,
    });
    if (!minDate || bookedAt < minDate) minDate = bookedAt;
    if (!maxDate || bookedAt > maxDate) maxDate = bookedAt;
  }

  // Require several confident rows — a couple of stray date+amount lines (headers,
  // summaries) are not a parseable statement.
  if (rows.length < 3) throw new UnsupportedStatementError();
  return { rows, periodStart: minDate, periodEnd: maxDate };
}
