import { useState } from "react";
import { useFetch } from "../api/hooks.js";
import { api, ApiError } from "../api/client.js";
import { Card, EmptyState, ErrorText, Field, Modal, PageHeader, Spinner } from "../components/ui.js";
import { formatMoney, toMinor, todayInput } from "../lib/format.js";

interface Budget {
  id: string;
  name: string;
  period: string;
  limitMinor: number;
  spentMinor: number;
  category: { name: string; colour: string } | null;
}
interface Category { id: string; name: string }

const BLANK = { name: "", categoryId: "", period: "MONTHLY", limit: "" };

export default function Budgets() {
  const { data, loading, error, refetch } = useFetch<{ items: Budget[] }>("/budgets");
  const { data: categoriesData } = useFetch<{ items: Category[] }>("/categories");
  const categories = categoriesData?.items ?? [];
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(BLANK);
  const [formError, setFormError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    try {
      await api.post("/budgets", {
        name: form.name,
        categoryId: form.categoryId || undefined,
        period: form.period,
        limitMinor: toMinor(form.limit),
        startDate: new Date(todayInput()).toISOString(),
      });
      setOpen(false);
      setForm(BLANK);
      await refetch();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not save");
    }
  }
  async function remove(b: Budget) {
    if (!confirm(`Delete budget "${b.name}"?`)) return;
    await api.del(`/budgets/${b.id}`);
    await refetch();
  }

  if (loading) return <Spinner />;
  if (error) return <EmptyState title="Could not load budgets" hint={error} />;
  const items = data?.items ?? [];

  return (
    <div>
      <PageHeader title="Budgets" subtitle="Track spending against limits" actions={<button className="btn-primary" onClick={() => { setForm(BLANK); setOpen(true); }}>Add budget</button>} />

      {items.length === 0 ? (
        <EmptyState title="No budgets yet" hint="Set a monthly or yearly limit per category." />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {items.map((b) => {
            const pct = b.limitMinor > 0 ? Math.min(100, Math.round((b.spentMinor / b.limitMinor) * 100)) : 0;
            const over = b.spentMinor > b.limitMinor;
            return (
              <Card key={b.id}>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-semibold text-slate-900">{b.name}</div>
                    <div className="text-xs text-slate-400">{b.category?.name ?? "All spending"} · {b.period.toLowerCase()}</div>
                  </div>
                  <button className="text-xs text-slate-400 hover:text-red-600" onClick={() => remove(b)}>Delete</button>
                </div>
                <div className="mt-4">
                  <div className="mb-1 flex justify-between text-sm">
                    <span className="tabular-nums text-slate-700">{formatMoney(b.spentMinor)}</span>
                    <span className="tabular-nums text-slate-400">of {formatMoney(b.limitMinor)}</span>
                  </div>
                  <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
                    <div className={`h-full rounded-full ${over ? "bg-red-500" : pct > 80 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${pct}%` }} />
                  </div>
                  {over && <div className="mt-1 text-xs text-red-600">Over budget by {formatMoney(b.spentMinor - b.limitMinor)}</div>}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Modal open={open} title="Add budget" onClose={() => setOpen(false)}>
        <form onSubmit={save} className="space-y-4">
          <Field label="Name"><input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Groceries" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category">
              <select className="input" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
                <option value="">All spending</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Period">
              <select className="input" value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })}>
                <option value="MONTHLY">Monthly</option>
                <option value="YEARLY">Yearly</option>
              </select>
            </Field>
          </div>
          <Field label="Limit (£)"><input className="input" required value={form.limit} onChange={(e) => setForm({ ...form, limit: e.target.value })} placeholder="300.00" /></Field>
          <ErrorText>{formError}</ErrorText>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn-primary">Add budget</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
