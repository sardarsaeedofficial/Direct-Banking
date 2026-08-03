import { useState } from "react";
import { useFetch } from "../api/hooks.js";
import { Card, EmptyState, PageHeader, Spinner } from "../components/ui.js";
import { formatMoney } from "../lib/format.js";

interface Totals { incomeMinor: number; expenseMinor: number; netMinor: number; count: number }
interface Grouped { key: string; label: string; incomeMinor: number; expenseMinor: number; count: number }
interface MonthlyReport { year: number; month: number; totals: Totals; byCategory: Grouped[]; byMerchant: Grouped[]; byAccount: Grouped[] }
interface YearlyReport { year: number; totals: Totals; months: Array<{ month: number } & Totals>; byCategory: Grouped[] }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function Reports() {
  const now = new Date();
  const [scope, setScope] = useState<"month" | "year">("month");
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth() + 1);

  const path = scope === "month" ? `/reports/monthly?year=${year}&month=${month}` : `/reports/yearly?year=${year}`;
  const { data, loading, error } = useFetch<MonthlyReport | YearlyReport>(path, [path]);

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle="Monthly and yearly summaries"
        actions={
          <>
            <a className="btn-ghost" href="/api/reports/transactions.csv" download>Export transactions CSV</a>
            <button className="btn-ghost" onClick={() => window.print()}>Print</button>
          </>
        }
      />

      <Card className="mb-6 print:hidden">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex rounded-lg bg-slate-100 p-1 text-sm font-medium">
            {(["month", "year"] as const).map((s) => (
              <button key={s} className={`rounded-md px-3 py-1.5 ${scope === s ? "bg-white shadow-sm" : "text-slate-500"}`} onClick={() => setScope(s)}>
                {s === "month" ? "Monthly" : "Yearly"}
              </button>
            ))}
          </div>
          <select className="input w-auto" value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {Array.from({ length: 6 }, (_, i) => now.getUTCFullYear() - i).map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          {scope === "month" && (
            <select className="input w-auto" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          )}
          {scope === "month" && <a className="btn-ghost" href={`/api/reports/monthly.csv?year=${year}&month=${month}`} download>Download this report</a>}
        </div>
      </Card>

      {loading ? (
        <Spinner />
      ) : error || !data ? (
        <EmptyState title="Could not load the report" hint={error ?? undefined} />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Income" minor={data.totals.incomeMinor} tone="text-emerald-600" />
            <Stat label="Expenditure" minor={data.totals.expenseMinor} tone="text-red-600" />
            <Stat label="Net" minor={data.totals.netMinor} tone={data.totals.netMinor >= 0 ? "text-emerald-600" : "text-red-600"} />
            <Stat label="Transactions" minor={data.totals.count} raw />
          </div>

          {"months" in data && (
            <Card>
              <h3 className="mb-4 font-semibold text-slate-800">Month by month</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase text-slate-400"><tr><th className="py-2">Month</th><th className="py-2 text-right">Income</th><th className="py-2 text-right">Expenditure</th><th className="py-2 text-right">Net</th></tr></thead>
                  <tbody className="divide-y divide-slate-50">
                    {data.months.map((m) => (
                      <tr key={m.month}>
                        <td className="py-2">{MONTHS[m.month - 1]}</td>
                        <td className="py-2 text-right tabular-nums text-emerald-600">{formatMoney(m.incomeMinor)}</td>
                        <td className="py-2 text-right tabular-nums text-red-600">{formatMoney(m.expenseMinor)}</td>
                        <td className="py-2 text-right tabular-nums">{formatMoney(m.netMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <GroupedTable title="By category" rows={data.byCategory} />
          {"byMerchant" in data && <GroupedTable title="By merchant" rows={data.byMerchant} />}
          {"byAccount" in data && <GroupedTable title="By account" rows={data.byAccount} />}
        </div>
      )}
    </div>
  );
}

function Stat({ label, minor, tone = "text-slate-900", raw = false }: { label: string; minor: number; tone?: string; raw?: boolean }) {
  return (
    <Card>
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-2 text-2xl font-bold tabular-nums ${tone}`}>{raw ? minor : formatMoney(minor)}</div>
    </Card>
  );
}

function GroupedTable({ title, rows }: { title: string; rows: Grouped[] }) {
  if (rows.length === 0) return null;
  return (
    <Card>
      <h3 className="mb-4 font-semibold text-slate-800">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-slate-400"><tr><th className="py-2">Name</th><th className="py-2 text-right">Expenditure</th><th className="py-2 text-right">Income</th><th className="py-2 text-right">Count</th></tr></thead>
          <tbody className="divide-y divide-slate-50">
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="py-2">{r.label}</td>
                <td className="py-2 text-right tabular-nums text-red-600">{formatMoney(r.expenseMinor)}</td>
                <td className="py-2 text-right tabular-nums text-emerald-600">{formatMoney(r.incomeMinor)}</td>
                <td className="py-2 text-right tabular-nums text-slate-500">{r.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
