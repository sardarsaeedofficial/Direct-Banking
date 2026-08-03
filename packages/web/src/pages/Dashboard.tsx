import { BarChart, Bar, PieChart, Pie, Cell, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from "recharts";
import { useFetch } from "../api/hooks.js";
import { Badge, Card, EmptyState, PageHeader, Spinner, StatTile } from "../components/ui.js";
import { formatMoney, formatDateUK, formatMonthLabel } from "../lib/format.js";
import { RECURRING_TYPE_LABELS } from "../lib/enums.js";

interface Dashboard {
  incomeMinor: number;
  expenseMinor: number;
  remainingDirectDebitsMinor: number;
  paidDirectDebitsMinor: number;
  safeToSpendMinor: number;
  expectedEndOfMonthBalanceMinor: number;
  totalBalanceMinor: number;
  upcoming: Array<{ id: string; merchantName: string; type: string; account: string; dueDate: string; amountMinor: number; status: string }>;
  monthlyChart: Array<{ month: string; incomeMinor: number; expenseMinor: number }>;
  yearlyChart: Array<{ year: number; incomeMinor: number; expenseMinor: number }>;
  spendingByCategory: Array<{ name: string; colour: string; amountMinor: number }>;
  spendingByAccount: Array<{ name: string; colour: string; amountMinor: number }>;
  subscriptions: Array<{ id: string; merchantName: string; type: string; frequency: string; expectedAmountMinor: number; nextDueDate: string }>;
  unusual: Array<{ type: string; severity: string; title: string; detail: string }>;
  forecast: { d7: Forecast; d14: Forecast; d30: Forecast };
}
interface Forecast {
  expectedOutMinor: number;
  projectedBalanceMinor: number;
  minProjectedBalanceMinor: number;
  minRequiredToCoverMinor: number;
}

const money = (m: number) => formatMoney(m);

export default function Dashboard() {
  const { data, loading, error } = useFetch<Dashboard>("/dashboard");
  if (loading) return <Spinner />;
  if (error || !data) return <EmptyState title="Could not load the dashboard" hint={error ?? undefined} />;

  return (
    <div>
      <PageHeader title="Dashboard" subtitle="This month at a glance" />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Income this month" minor={data.incomeMinor} tone="positive" />
        <StatTile label="Expenditure this month" minor={data.expenseMinor} tone="negative" />
        <StatTile label="Safe to spend" minor={data.safeToSpendMinor} tone={data.safeToSpendMinor < 0 ? "warning" : "default"} hint="Balance minus remaining direct debits" />
        <StatTile label="Expected end-of-month" minor={data.expectedEndOfMonthBalanceMinor} hint="After outstanding direct debits" />
        <StatTile label="Paid direct debits" minor={data.paidDirectDebitsMinor} tone="positive" />
        <StatTile label="Remaining direct debits" minor={data.remainingDirectDebitsMinor} tone="warning" />
        <StatTile label="Total balance" minor={data.totalBalanceMinor} hint="Across active accounts" />
        <StatTile label="Min. to cover 30 days" minor={data.forecast.d30.minRequiredToCoverMinor} hint="Upcoming bills, 30 days" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h3 className="mb-4 font-semibold text-slate-800">Monthly income vs expenditure</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.monthlyChart.map((m) => ({ label: formatMonthLabel(m.month), Income: m.incomeMinor / 100, Expenditure: m.expenseMinor / 100 }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} width={48} />
                <Tooltip formatter={(v: number) => formatMoney(Math.round(v * 100))} />
                <Legend />
                <Bar dataKey="Income" fill="#10b981" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Expenditure" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <h3 className="mb-4 font-semibold text-slate-800">Spending by category</h3>
          {data.spendingByCategory.length === 0 ? (
            <p className="text-sm text-slate-400">No expenditure yet this month.</p>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={data.spendingByCategory} dataKey="amountMinor" nameKey="name" innerRadius={45} outerRadius={80} paddingAngle={2}>
                    {data.spendingByCategory.map((c, i) => (
                      <Cell key={i} fill={c.colour} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number) => formatMoney(v)} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h3 className="mb-4 font-semibold text-slate-800">Upcoming payments</h3>
          {data.upcoming.length === 0 ? (
            <p className="text-sm text-slate-400">Nothing scheduled.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.upcoming.map((u) => (
                <li key={u.id} className="flex items-center justify-between py-2.5">
                  <div>
                    <div className="font-medium text-slate-800">{u.merchantName}</div>
                    <div className="text-xs text-slate-400">
                      {RECURRING_TYPE_LABELS[u.type] ?? u.type} · {u.account} · {formatDateUK(u.dueDate)}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge status={u.status} />
                    <span className="font-semibold tabular-nums text-slate-800">{money(u.amountMinor)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h3 className="mb-4 font-semibold text-slate-800">Unusual activity</h3>
          {data.unusual.length === 0 ? (
            <p className="text-sm text-slate-400">Nothing unusual detected.</p>
          ) : (
            <ul className="space-y-2">
              {data.unusual.slice(0, 6).map((a, i) => (
                <li key={i} className={`rounded-lg border-l-4 px-3 py-2 text-sm ${a.severity === "warning" ? "border-amber-400 bg-amber-50" : "border-sky-400 bg-sky-50"}`}>
                  <div className="font-medium text-slate-800">{a.title}</div>
                  <div className="text-xs text-slate-500">{a.detail}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <h3 className="mb-4 font-semibold text-slate-800">Spending by bank account</h3>
          {data.spendingByAccount.length === 0 ? (
            <p className="text-sm text-slate-400">No expenditure yet this month.</p>
          ) : (
            <ul className="space-y-2">
              {data.spendingByAccount.map((a, i) => (
                <li key={i} className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-sm text-slate-700">
                    <span className="h-3 w-3 rounded-full" style={{ background: a.colour }} />
                    {a.name}
                  </span>
                  <span className="font-medium tabular-nums">{money(a.amountMinor)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h3 className="mb-4 font-semibold text-slate-800">Recurring subscriptions</h3>
          {data.subscriptions.length === 0 ? (
            <p className="text-sm text-slate-400">No active recurring payments.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.subscriptions.slice(0, 8).map((s) => (
                <li key={s.id} className="flex items-center justify-between py-2">
                  <span className="text-sm text-slate-700">{s.merchantName}</span>
                  <span className="text-sm tabular-nums text-slate-600">
                    {money(s.expectedAmountMinor)} · next {formatDateUK(s.nextDueDate)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
