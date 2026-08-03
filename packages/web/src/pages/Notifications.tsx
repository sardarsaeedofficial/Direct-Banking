import { useState } from "react";
import { useFetch } from "../api/hooks.js";
import { api, ApiError } from "../api/client.js";
import { Badge, Card, EmptyState, ErrorText, Field, PageHeader, Spinner } from "../components/ui.js";
import { formatDateTimeUK, formatMoney } from "../lib/format.js";

interface Account { id: string; nickname: string }
interface Notif { id: string; sourcePackage: string; title: string; message: string; receivedAt: string; parsedMerchant: string | null; parsedAmountMinor: number | null; parsedAccount: string | null; confidence: number; status: string }
interface Reminder { id: string; channel: string; status: string; fireAt: string; message: string | null; recurring: { merchantName: string } | null }

export default function Notifications() {
  const { data: accountsData } = useFetch<{ items: Account[] }>("/accounts");
  const accounts = accountsData?.items ?? [];
  const { data: queue, loading, error, refetch } = useFetch<{ items: Notif[] }>("/notifications?status=PENDING");
  const { data: reminders, refetch: refetchReminders } = useFetch<{ items: Reminder[] }>("/reminders");
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [sim, setSim] = useState({ sourcePackage: "com.monzo.app", title: "Payment sent", message: "You paid £12.99 to Netflix" });
  const [simError, setSimError] = useState<string | null>(null);

  async function decide(n: Notif, status: "APPROVED" | "REJECTED") {
    const accountId = chosen[n.id] || accounts[0]?.id;
    await api.post(`/notifications/${n.id}/decision`, { status, accountId }).catch((e) => alert(e instanceof ApiError ? e.message : "Failed"));
    await refetch();
  }

  async function simulate(e: React.FormEvent) {
    e.preventDefault();
    setSimError(null);
    try {
      await api.post("/notifications/ingest", { ...sim, receivedAt: new Date().toISOString() });
      await refetch();
    } catch (err) {
      setSimError(err instanceof ApiError ? err.message : "Failed");
    }
  }

  async function dismiss(r: Reminder) {
    await api.patch(`/reminders/${r.id}/dismiss`, {});
    await refetchReminders();
  }

  return (
    <div>
      <PageHeader title="Notifications" subtitle="Reminders and the notification-import review queue" />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-3 font-semibold text-slate-800">Review queue</h3>
          <Card className="mb-4">
            <form onSubmit={simulate} className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Simulate an incoming notification</div>
              <input className="input" value={sim.sourcePackage} onChange={(e) => setSim({ ...sim, sourcePackage: e.target.value })} placeholder="source package" />
              <input className="input" value={sim.title} onChange={(e) => setSim({ ...sim, title: e.target.value })} placeholder="title" />
              <input className="input" value={sim.message} onChange={(e) => setSim({ ...sim, message: e.target.value })} placeholder="message" />
              <ErrorText>{simError}</ErrorText>
              <button className="btn-ghost w-full">Add to queue</button>
            </form>
          </Card>

          {loading ? (
            <Spinner />
          ) : error ? (
            <EmptyState title="Could not load the queue" hint={error} />
          ) : (queue?.items.length ?? 0) === 0 ? (
            <EmptyState title="Nothing to review" hint="Low-confidence imports wait here for your approval." />
          ) : (
            <div className="space-y-3">
              {queue!.items.map((n) => (
                <Card key={n.id}>
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="font-medium text-slate-800">{n.parsedMerchant ?? n.title}</div>
                      <div className="text-xs text-slate-400">{n.message}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-semibold tabular-nums">{n.parsedAmountMinor != null ? formatMoney(n.parsedAmountMinor) : "—"}</div>
                      <div className={`text-[11px] ${n.confidence < 0.5 ? "text-amber-600" : "text-emerald-600"}`}>{Math.round(n.confidence * 100)}% confidence</div>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <select className="input" value={chosen[n.id] ?? ""} onChange={(e) => setChosen({ ...chosen, [n.id]: e.target.value })}>
                      <option value="">{n.parsedAccount ? `${n.parsedAccount}?` : "Choose account"}</option>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.nickname}</option>)}
                    </select>
                    <button className="btn-primary" onClick={() => decide(n, "APPROVED")}>Approve</button>
                    <button className="btn-ghost" onClick={() => decide(n, "REJECTED")}>Reject</button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>

        <div>
          <h3 className="mb-3 font-semibold text-slate-800">Reminders</h3>
          {(reminders?.items.length ?? 0) === 0 ? (
            <EmptyState title="No reminders" hint="Reminders are created automatically for upcoming direct debits." />
          ) : (
            <div className="space-y-2">
              {reminders!.items.map((r) => (
                <Card key={r.id}>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium text-slate-800">{r.recurring?.merchantName ?? r.message ?? "Reminder"}</div>
                      <div className="text-xs text-slate-400">{r.channel} · fires {formatDateTimeUK(r.fireAt)}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge status={r.status} />
                      {r.status !== "DISMISSED" && <button className="text-xs text-slate-400 hover:text-slate-700" onClick={() => dismiss(r)}>Dismiss</button>}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
