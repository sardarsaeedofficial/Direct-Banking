import { useState } from "react";
import { useFetch } from "../api/hooks.js";
import { api, ApiError } from "../api/client.js";
import { Badge, Card, EmptyState, ErrorText, Field, Modal, PageHeader, Spinner } from "../components/ui.js";
import { formatDateUK, formatMoney, toMinor, todayInput } from "../lib/format.js";
import { FREQUENCIES, FREQUENCY_LABELS, RECURRING_TYPES, RECURRING_TYPE_LABELS } from "../lib/enums.js";

interface Recurring {
  id: string;
  type: string;
  merchantName: string;
  expectedAmountMinor: number;
  isVariable: boolean;
  frequency: string;
  dayOfMonth: number | null;
  nextDueDate: string;
  reminderDays: number;
  status: string;
  account: { nickname: string; colour: string };
  category: { name: string } | null;
}
interface Account { id: string; nickname: string }
interface Category { id: string; name: string }

const BLANK = {
  type: "DIRECT_DEBIT",
  merchantName: "",
  accountId: "",
  amount: "",
  isVariable: false,
  frequency: "MONTHLY",
  dayOfMonth: "1",
  nextDueDate: todayInput(),
  startDate: todayInput(),
  reminderDays: "5",
  categoryId: "",
  notes: "",
};

export default function DirectDebits() {
  const { data, loading, error, refetch } = useFetch<{ items: Recurring[] }>("/recurring");
  const { data: accountsData } = useFetch<{ items: Account[] }>("/accounts");
  const { data: categoriesData } = useFetch<{ items: Category[] }>("/categories");
  const accounts = accountsData?.items ?? [];
  const categories = categoriesData?.items ?? [];

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(BLANK);
  const [formError, setFormError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    try {
      await api.post("/recurring", {
        type: form.type,
        merchantName: form.merchantName,
        accountId: form.accountId || accounts[0]?.id,
        expectedAmountMinor: toMinor(form.amount),
        isVariable: form.isVariable,
        frequency: form.frequency,
        dayOfMonth: form.frequency === "MONTHLY" || form.frequency === "QUARTERLY" || form.frequency === "ANNUAL" || form.frequency === "BIANNUAL" ? Number(form.dayOfMonth) : undefined,
        nextDueDate: new Date(form.nextDueDate).toISOString(),
        startDate: new Date(form.startDate).toISOString(),
        reminderDays: Number(form.reminderDays),
        categoryId: form.categoryId || undefined,
        notes: form.notes || undefined,
      });
      setOpen(false);
      setForm(BLANK);
      await refetch();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  async function end(r: Recurring) {
    if (!confirm(`End ${r.merchantName}? Future projections are removed; history is kept.`)) return;
    await api.del(`/recurring/${r.id}`);
    await refetch();
  }

  if (loading) return <Spinner />;
  if (error) return <EmptyState title="Could not load direct debits" hint={error} />;
  const items = data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Direct Debits"
        subtitle="Recurring payments — future expected payments are generated automatically"
        actions={<button className="btn-primary" onClick={() => { setForm({ ...BLANK, accountId: accounts[0]?.id ?? "" }); setOpen(true); }}>Add recurring payment</button>}
      />

      {items.length === 0 ? (
        <EmptyState title="No recurring payments yet" hint="Add a direct debit, subscription, rent or standing order." />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {items.map((r) => (
            <Card key={r.id}>
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-900">{r.merchantName}</span>
                    <Badge status={r.status} />
                  </div>
                  <div className="mt-1 text-xs text-slate-400">
                    {RECURRING_TYPE_LABELS[r.type]} · {FREQUENCY_LABELS[r.frequency]}
                    {r.dayOfMonth ? ` · day ${r.dayOfMonth}` : ""} · {r.account.nickname}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-bold tabular-nums text-slate-900">{formatMoney(r.expectedAmountMinor)}</div>
                  {r.isVariable && <div className="text-[11px] text-amber-600">variable</div>}
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-500">
                <span>Next due {formatDateUK(r.nextDueDate)}</span>
                <span>Reminder {r.reminderDays}d before</span>
              </div>
              <div className="mt-3 flex justify-end">
                <button className="text-xs text-slate-400 hover:text-red-600" onClick={() => end(r)}>End</button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={open} title="Add recurring payment" onClose={() => setOpen(false)}>
        <form onSubmit={save} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {RECURRING_TYPES.map((t) => <option key={t} value={t}>{RECURRING_TYPE_LABELS[t]}</option>)}
              </select>
            </Field>
            <Field label="Merchant / company"><input className="input" required value={form.merchantName} onChange={(e) => setForm({ ...form, merchantName: e.target.value })} placeholder="e.g. Helifica" /></Field>
            <Field label="Account">
              <select className="input" value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.nickname}</option>)}
              </select>
            </Field>
            <Field label="Amount (£)"><input className="input" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="85.00" /></Field>
            <Field label="Frequency">
              <select className="input" value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
                {FREQUENCIES.map((f) => <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>)}
              </select>
            </Field>
            <Field label="Day of month"><input className="input" type="number" min={1} max={31} value={form.dayOfMonth} onChange={(e) => setForm({ ...form, dayOfMonth: e.target.value })} /></Field>
            <Field label="Next due date"><input className="input" type="date" value={form.nextDueDate} onChange={(e) => setForm({ ...form, nextDueDate: e.target.value })} /></Field>
            <Field label="Start date"><input className="input" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></Field>
            <Field label="Reminder (days before)"><input className="input" type="number" min={0} max={60} value={form.reminderDays} onChange={(e) => setForm({ ...form, reminderDays: e.target.value })} /></Field>
            <Field label="Category">
              <select className="input" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
                <option value="">Uncategorised</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={form.isVariable} onChange={(e) => setForm({ ...form, isVariable: e.target.checked })} />
            Variable amount (don't alert on small changes)
          </label>
          <ErrorText>{formError}</ErrorText>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn-primary">Add</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
