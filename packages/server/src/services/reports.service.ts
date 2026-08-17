import { prisma } from "../db.js";

interface Range {
  from: Date;
  to: Date;
}

function monthRange(year: number, month1to12: number): Range {
  return {
    from: new Date(Date.UTC(year, month1to12 - 1, 1)),
    to: new Date(Date.UTC(year, month1to12, 1)),
  };
}
function yearRange(year: number): Range {
  return { from: new Date(Date.UTC(year, 0, 1)), to: new Date(Date.UTC(year + 1, 0, 1)) };
}

async function totals(userId: string, range: Range) {
  const txns = await prisma.transaction.findMany({
    where: { userId, parentId: null, status: { in: ["COMPLETED", "PENDING"] }, bookedAt: { gte: range.from, lt: range.to } },
    select: { direction: true, amountMinor: true },
  });
  let incomeMinor = 0;
  let expenseMinor = 0;
  for (const t of txns) {
    if (t.direction === "INCOME") incomeMinor += Number(t.amountMinor);
    else if (t.direction === "EXPENSE") expenseMinor += Number(t.amountMinor);
  }
  return { incomeMinor, expenseMinor, netMinor: incomeMinor - expenseMinor, count: txns.length };
}

type Grouped = Array<{ key: string; label: string; incomeMinor: number; expenseMinor: number; count: number }>;

async function groupBy(
  userId: string,
  range: Range,
  dimension: "category" | "merchant" | "account",
): Promise<Grouped> {
  const txns = await prisma.transaction.findMany({
    where: { userId, parentId: null, status: { in: ["COMPLETED", "PENDING"] }, bookedAt: { gte: range.from, lt: range.to } },
    select: {
      direction: true,
      amountMinor: true,
      categoryId: true,
      merchantId: true,
      accountId: true,
      category: { select: { name: true } },
      merchant: { select: { displayName: true } },
      account: { select: { nickname: true } },
    },
  });
  const map = new Map<string, { label: string; incomeMinor: number; expenseMinor: number; count: number }>();
  for (const t of txns) {
    let key: string;
    let label: string;
    if (dimension === "category") {
      key = t.categoryId ?? "uncategorised";
      label = t.category?.name ?? "Uncategorised";
    } else if (dimension === "merchant") {
      key = t.merchantId ?? "unknown";
      label = t.merchant?.displayName ?? "Unknown";
    } else {
      key = t.accountId;
      label = t.account.nickname;
    }
    const row = map.get(key) ?? { label, incomeMinor: 0, expenseMinor: 0, count: 0 };
    if (t.direction === "INCOME") row.incomeMinor += Number(t.amountMinor);
    else if (t.direction === "EXPENSE") row.expenseMinor += Number(t.amountMinor);
    row.count++;
    map.set(key, row);
  }
  return Array.from(map.entries())
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.expenseMinor - a.expenseMinor);
}

export async function monthlySummary(userId: string, year: number, month: number) {
  const range = monthRange(year, month);
  return {
    scope: "month" as const,
    year,
    month,
    totals: await totals(userId, range),
    byCategory: await groupBy(userId, range, "category"),
    byMerchant: await groupBy(userId, range, "merchant"),
    byAccount: await groupBy(userId, range, "account"),
  };
}

export async function yearlySummary(userId: string, year: number) {
  const range = yearRange(year);
  const months = [];
  for (let m = 1; m <= 12; m++) {
    months.push({ month: m, ...(await totals(userId, monthRange(year, m))) });
  }
  return {
    scope: "year" as const,
    year,
    totals: await totals(userId, range),
    months,
    byCategory: await groupBy(userId, range, "category"),
    byMerchant: await groupBy(userId, range, "merchant"),
    byAccount: await groupBy(userId, range, "account"),
  };
}

export async function recurringReport(userId: string) {
  const items = await prisma.recurringPayment.findMany({
    where: { userId },
    include: { account: { select: { nickname: true } }, category: { select: { name: true } } },
    orderBy: [{ status: "asc" }, { nextDueDate: "asc" }],
  });
  // Normalise each to an approximate monthly cost for comparison.
  const perMonthFactor: Record<string, number> = {
    WEEKLY: 52 / 12,
    FORTNIGHTLY: 26 / 12,
    FOUR_WEEKLY: 13 / 12,
    MONTHLY: 1,
    QUARTERLY: 1 / 3,
    BIANNUAL: 1 / 6,
    ANNUAL: 1 / 12,
    CUSTOM: 1,
  };
  const rows = items.map((r) => ({
    id: r.id,
    merchantName: r.merchantName,
    type: r.type,
    frequency: r.frequency,
    account: r.account.nickname,
    category: r.category?.name ?? null,
    status: r.status,
    amountMinor: Number(r.expectedAmountMinor),
    approxMonthlyMinor: Math.round(Number(r.expectedAmountMinor) * (perMonthFactor[r.frequency] ?? 1)),
    nextDueDate: r.nextDueDate.toISOString(),
  }));
  const totalMonthlyMinor = rows.filter((r) => r.status === "ACTIVE").reduce((s, r) => s + r.approxMonthlyMinor, 0);
  return { rows, totalMonthlyMinor };
}

/** Convert a report's grouped rows into CSV text. */
export function groupedToCsv(title: string, rows: Grouped): string {
  const header = ["Key", "Label", "Income", "Expense", "Count"];
  const lines = rows.map((r) =>
    [r.key, r.label, (r.incomeMinor / 100).toFixed(2), (r.expenseMinor / 100).toFixed(2), String(r.count)]
      .map(csvCell)
      .join(","),
  );
  return `# ${title}\n${header.join(",")}\n${lines.join("\n")}\n`;
}

/** Escape a value for CSV and neutralise spreadsheet-formula injection (Phase 6
 *  security audit): a cell beginning with = + - @ is prefixed with a leading
 *  apostrophe so a spreadsheet application never executes it as a formula. */
export function csvCell(value: string): string {
  let s = value;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Export raw transactions in a date range as CSV. */
export async function transactionsCsv(userId: string, range: { from?: Date; to?: Date }): Promise<string> {
  const txns = await prisma.transaction.findMany({
    where: {
      userId,
      bookedAt: { gte: range.from ?? new Date(0), lt: range.to ?? new Date(8.64e15) },
    },
    include: { account: { select: { nickname: true } }, category: { select: { name: true } }, merchant: { select: { displayName: true } } },
    orderBy: { bookedAt: "desc" },
  });
  const header = ["Date", "Account", "Direction", "Status", "Description", "Merchant", "Category", "Amount", "Currency", "Tags"];
  const lines = txns.map((t) =>
    [
      t.bookedAt.toISOString().slice(0, 10),
      t.account.nickname,
      t.direction,
      t.status,
      t.description,
      t.merchant?.displayName ?? "",
      t.category?.name ?? "",
      (Number(t.amountMinor) / 100).toFixed(2),
      t.currency,
      t.tags.join(" "),
    ]
      .map((c) => csvCell(String(c)))
      .join(","),
  );
  return `${header.join(",")}\n${lines.join("\n")}\n`;
}
