import type { Prisma, TxnDirection, TxnType } from "@prisma/client";
import { prisma } from "../db.js";

// User-owned CSV export of canonical financial data (Phase 5). Exports only ledger
// information — never Plaid tokens, raw notifications, provider credentials or
// encryption material. Cells are CSV-escaped AND formula-injection–neutralised.

export interface ExportFilters {
  accountId?: string;
  from?: Date;
  to?: Date;
  categoryId?: string;
  transactionType?: TxnType;
}

/**
 * Escape a value for CSV and neutralise spreadsheet-formula injection: any cell that
 * begins with = + - @ (or a control char that Excel treats as a formula lead) is
 * prefixed with a single quote so it can never execute in a spreadsheet.
 */
export function csvCell(value: string | number | null | undefined): string {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

const HEADERS = [
  "Date", "Time", "Account", "Direction", "Type", "AmountMinor", "Amount", "Currency",
  "Description", "Merchant", "Category", "Reference", "Status", "InternalTransfer",
];

function amountDisplay(minor: bigint): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const s = abs.toString().padStart(3, "0");
  return `${neg ? "-" : ""}${s.slice(0, -2)}.${s.slice(-2)}`;
}

/** Build a CSV string of the user's transactions matching the filters. Ownership is
 *  enforced by scoping every query to userId. */
export async function exportTransactionsCsv(userId: string, filters: ExportFilters): Promise<string> {
  const where: Prisma.TransactionWhereInput = {
    userId,
    parentId: null,
    ...(filters.accountId ? { accountId: filters.accountId } : {}),
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(filters.transactionType ? { transactionType: filters.transactionType } : {}),
    ...(filters.from || filters.to
      ? { bookedAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
      : {}),
  };

  const rows = await prisma.transaction.findMany({
    where,
    orderBy: { bookedAt: "desc" },
    take: 20000, // bounded export
    select: {
      bookedAt: true,
      occurredAt: true,
      direction: true,
      transactionType: true,
      amountMinor: true,
      currency: true,
      description: true,
      merchantName: true,
      paymentReference: true,
      status: true,
      internalTransferGroupId: true,
      account: { select: { nickname: true } },
      category: { select: { name: true } },
      merchant: { select: { displayName: true } },
    },
  });

  const lines = [HEADERS.join(",")];
  for (const t of rows) {
    const signed = t.direction === ("INCOME" as TxnDirection) ? t.amountMinor : -t.amountMinor;
    lines.push(
      [
        csvCell(t.bookedAt ? t.bookedAt.toISOString().slice(0, 10) : ""),
        csvCell(t.bookedAt ? t.bookedAt.toISOString().slice(11, 19) : ""),
        csvCell(t.account?.nickname ?? ""),
        csvCell(t.direction),
        csvCell(t.transactionType ?? ""),
        csvCell(signed.toString()),
        csvCell(amountDisplay(signed)),
        csvCell(t.currency),
        csvCell(t.description),
        csvCell(t.merchant?.displayName ?? t.merchantName ?? ""),
        csvCell(t.category?.name ?? ""),
        csvCell(t.paymentReference ?? ""),
        csvCell(t.status),
        csvCell(t.internalTransferGroupId ? "yes" : "no"),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
