import type { TxnDirection } from "@prisma/client";
import type { CsvMappingInput } from "@direct-banking/shared";
import { toMinor } from "@direct-banking/shared";
import { prisma } from "../db.js";
import { parseCsv, parseDate } from "../utils/csv.js";
import { dedupeHash, isDuplicate } from "./duplicate-detection.service.js";
import { createTransaction } from "./transactions.service.js";
import { HttpError } from "../middleware/error.js";

export interface PreviewRow {
  index: number;
  bookedAt: string | null;
  description: string;
  amountMinor: number;
  direction: TxnDirection;
  duplicate: boolean;
  error?: string;
}

function cell(row: string[], idx: number | undefined): string {
  return idx === undefined ? "" : (row[idx] ?? "").trim();
}

function deriveAmount(row: string[], m: CsvMappingInput): { amountMinor: number; direction: TxnDirection } {
  const cols = m.columns;
  if (cols.debit !== undefined || cols.credit !== undefined) {
    const debit = cell(row, cols.debit);
    const credit = cell(row, cols.credit);
    if (debit) return { amountMinor: Math.abs(toMinor(debit)), direction: "EXPENSE" };
    if (credit) return { amountMinor: Math.abs(toMinor(credit)), direction: "INCOME" };
    return { amountMinor: 0, direction: "EXPENSE" };
  }
  const raw = cell(row, cols.amount);
  const signed = toMinor(raw.replace(/^\((.*)\)$/, "-$1"));
  return { amountMinor: Math.abs(signed), direction: signed < 0 ? "EXPENSE" : "INCOME" };
}

/** Parse + map a CSV into preview rows, flagging duplicates. Persists nothing. */
export async function previewCsv(userId: string, text: string, mapping: CsvMappingInput): Promise<{ rows: PreviewRow[]; rowCount: number; duplicateCount: number }> {
  const account = await prisma.bankAccount.findFirst({ where: { id: mapping.accountId, userId } });
  if (!account) throw new HttpError(404, "Account not found");

  const parsed = parseCsv(text);
  const dataRows = mapping.hasHeader ? parsed.slice(1) : parsed;
  const rows: PreviewRow[] = [];
  let duplicateCount = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const raw = dataRows[i]!;
    const description = cell(raw, mapping.columns.description) || "(no description)";
    const date = parseDate(cell(raw, mapping.columns.date), mapping.dateFormat);
    let error: string | undefined;
    let amountMinor = 0;
    let direction: TxnDirection = "EXPENSE";
    try {
      ({ amountMinor, direction } = deriveAmount(raw, mapping));
    } catch {
      error = "Unparseable amount";
    }
    if (!date) error = error ?? "Unparseable date";

    let duplicate = false;
    if (date && !error) {
      const hash = dedupeHash({ accountId: mapping.accountId, bookedAt: date, amountMinor: BigInt(amountMinor), direction, description });
      duplicate = await isDuplicate(userId, hash);
      if (duplicate) duplicateCount++;
    }

    rows.push({
      index: i,
      bookedAt: date ? date.toISOString() : null,
      description,
      amountMinor,
      direction,
      duplicate,
      error,
    });
  }

  return { rows, rowCount: dataRows.length, duplicateCount };
}

/** Commit a CSV import inside one transaction batch, skipping duplicates. */
export async function commitCsv(
  userId: string,
  text: string,
  mapping: CsvMappingInput,
  filename: string | undefined,
  skipDuplicates: boolean,
): Promise<{ batchId: string; imported: number; skipped: number }> {
  const preview = await previewCsv(userId, text, mapping);

  const batch = await prisma.importBatch.create({
    data: {
      userId,
      filename,
      source: "CSV_IMPORT",
      status: "PREVIEW",
      columnMapping: mapping as unknown as object,
      rowCount: preview.rowCount,
      duplicateCount: preview.duplicateCount,
    },
  });

  let imported = 0;
  let skipped = 0;
  for (const row of preview.rows) {
    if (row.error || !row.bookedAt) {
      skipped++;
      continue;
    }
    if (row.duplicate && skipDuplicates) {
      skipped++;
      continue;
    }
    await createTransaction(userId, {
      accountId: mapping.accountId,
      direction: row.direction,
      source: "CSV_IMPORT",
      amountMinor: row.amountMinor,
      bookedAt: new Date(row.bookedAt),
      description: row.description,
      importBatchId: batch.id,
    });
    imported++;
  }

  await prisma.importBatch.update({
    where: { id: batch.id },
    data: { status: "COMMITTED", importedCount: imported, committedAt: new Date() },
  });

  return { batchId: batch.id, imported, skipped };
}

/** Roll back an import batch: delete its transactions, mark it rolled back. */
export async function rollbackBatch(userId: string, batchId: string): Promise<number> {
  const batch = await prisma.importBatch.findFirst({ where: { id: batchId, userId } });
  if (!batch) throw new HttpError(404, "Import batch not found");
  if (batch.status === "ROLLED_BACK") throw new HttpError(409, "Batch already rolled back");

  const deleted = await prisma.$transaction(async (tx) => {
    const del = await tx.transaction.deleteMany({ where: { userId, importBatchId: batchId } });
    await tx.importBatch.update({ where: { id: batchId }, data: { status: "ROLLED_BACK", rolledBackAt: new Date() } });
    return del.count;
  });
  return deleted;
}
