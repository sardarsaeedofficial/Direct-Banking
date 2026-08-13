import { parseDate, parseMoneyToMinor, UnsupportedStatementError, type Direction, type ParsedRow, type ParseResult } from "./normalise.js";

/** Read an OFX/SGML tag value: text after <TAG> up to the next tag or line end. */
function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}>\\s*([^<\\r\\n]*)`, "i"));
  return m ? m[1].trim() || null : null;
}

/**
 * Parse an OFX statement (Money/QIF exporters, most UK banks' "download as OFX").
 * OFX is SGML-ish: tags are often not closed. Each <STMTTRN> is one transaction.
 * TRNAMT sign gives direction. Rejects files with no <STMTTRN> blocks.
 */
export function parseOfx(text: string): ParseResult {
  if (!/<STMTTRN>/i.test(text)) throw new UnsupportedStatementError();
  const curDef = tag(text, "CURDEF");
  const currency = (curDef ?? "GBP").toUpperCase().slice(0, 3) || "GBP";

  const blocks = text.split(/<STMTTRN>/i).slice(1);
  const rows: ParsedRow[] = [];
  let minDate: Date | null = null;
  let maxDate: Date | null = null;

  blocks.forEach((raw, idx) => {
    const block = raw.split(/<\/STMTTRN>/i)[0];
    const bookedAt = parseDate(tag(block, "DTPOSTED") ?? tag(block, "DTUSER") ?? "");
    const amt = parseMoneyToMinor(tag(block, "TRNAMT") ?? "");
    if (!bookedAt || !amt || amt.minor <= 0) return; // never invent missing data

    const direction: Direction = amt.sign < 0 ? "EXPENSE" : "INCOME";
    const name = tag(block, "NAME");
    const memo = tag(block, "MEMO");
    const fitid = tag(block, "FITID");
    const description = name || memo || "Statement transaction";

    rows.push({
      rowIndex: idx + 1,
      bookedAt,
      amountMinor: amt.minor,
      currency,
      direction,
      description,
      reference: fitid || memo || null,
    });
    if (!minDate || bookedAt < minDate) minDate = bookedAt;
    if (!maxDate || bookedAt > maxDate) maxDate = bookedAt;
  });

  if (rows.length === 0) throw new UnsupportedStatementError();
  const org = tag(text, "ORG");
  return { rows, institution: org, periodStart: minDate, periodEnd: maxDate };
}
