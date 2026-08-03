import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from "recharts";
import { useFetch } from "../api/hooks.js";
import { Badge, Card, EmptyState, PageHeader, Spinner } from "../components/ui.js";
import { formatDateUK, formatMoney } from "../lib/format.js";

interface CalEvent { id: string; date: string; merchantName: string; type: string; account: string; colour: string; amountMinor: number; status: string }
interface Projection { date: string; balanceMinor: number; outMinor: number }
interface CalendarData { from: string; to: string; events: CalEvent[]; projection: Projection[] }

export default function Calendar() {
  const { data, loading, error } = useFetch<CalendarData>("/calendar");
  if (loading) return <Spinner />;
  if (error || !data) return <EmptyState title="Could not load the calendar" hint={error ?? undefined} />;

  const grouped = new Map<string, CalEvent[]>();
  for (const e of data.events) {
    const key = e.date.slice(0, 10);
    grouped.set(key, [...(grouped.get(key) ?? []), e]);
  }
  const minBalance = Math.min(...data.projection.map((p) => p.balanceMinor), 0);

  return (
    <div>
      <PageHeader title="Calendar & forecast" subtitle="Upcoming payments and your projected daily balance" />

      <Card className="mb-6">
        <h3 className="mb-4 font-semibold text-slate-800">Projected daily balance</h3>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.projection.map((p) => ({ label: formatDateUK(p.date).slice(0, 5), Balance: p.balanceMinor / 100 }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={20} />
              <YAxis tick={{ fontSize: 11 }} width={52} />
              <Tooltip formatter={(v: number) => formatMoney(Math.round(v * 100))} />
              <ReferenceLine y={0} stroke="#ef4444" strokeDasharray="4 4" />
              <Line type="monotone" dataKey="Balance" stroke="#2563eb" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        {minBalance < 0 && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
            Heads up: your projected balance dips to {formatMoney(minBalance)} within this window.
          </p>
        )}
      </Card>

      <h3 className="mb-3 font-semibold text-slate-800">Upcoming timeline</h3>
      {grouped.size === 0 ? (
        <EmptyState title="No upcoming payments in this window" />
      ) : (
        <div className="space-y-4">
          {[...grouped.entries()].sort().map(([date, events]) => (
            <Card key={date}>
              <div className="mb-2 text-sm font-semibold text-slate-500">{formatDateUK(date)}</div>
              <ul className="divide-y divide-slate-100">
                {events.map((e) => (
                  <li key={e.id} className="flex items-center justify-between py-2">
                    <span className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: e.colour }} />
                      <span className="font-medium text-slate-800">{e.merchantName}</span>
                      <span className="text-xs text-slate-400">{e.account}</span>
                    </span>
                    <span className="flex items-center gap-3">
                      <Badge status={e.status} />
                      <span className="font-semibold tabular-nums text-slate-800">{formatMoney(e.amountMinor)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
