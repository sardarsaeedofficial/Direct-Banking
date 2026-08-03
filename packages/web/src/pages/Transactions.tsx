import { useMemo, useState } from "react";
import { useFetch } from "../api/hooks.js";
import { api, ApiError } from "../api/client.js";
import { Badge, Card, EmptyState, ErrorText, Field, Modal, PageHeader, Spinner } from "../components/ui.js";
import { formatDateUK, formatSignedMoney, toMinor, todayInput } from "../lib/format.js";

interface Txn {
  id: string;
  direction: "INCOME" | "EXPENSE" | "TRANSFER";
  status: string;
  amountMinor: number;
  bookedAt: string;
  description: string;
  account: { nickname: string; colour: string };
  category: { name: string; colour: string } | null;
  merchant: { displayName: string } | null;
}
interface Account { id: string; nickname: string }
interface Category { id: string; name: string }

const BLANK = { accountId: "", direction: "EXPENSE", amount: "", bookedAt: todayInput(), description: "", categoryId: "", merchantName: "" };

export default function Transactions() {
  const [filters, setFilters] = useState({ accountId: "", direction: "", search: "" });
  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (filters.accountId) p.set("accountId", filters.accountId);
    if (filters.direction) p.set("direction", filters.direction);
    if (filters.search) p.set("search", filters.search);
    p.set("pageSize", "100");
    return p.toString();
  }, [filters]);

  const { data, loading, error, refetch } = useFetch<{ items: Txn[]; total: number }>(`/transactions?${query}`, [query]);
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
      await api.post("/transactions", {
        accountId: form.accountId || accounts[0]?.id,
        direction: form.direction,
        amountMinor: toMinor(form.amount),
        bookedAt: new Date(form.bookedAt).toISOString(),
        description: form.description,
        categoryId: form.categoryId || undefined,
        merchantName: form.merchantName || undefined,
      });
      setOpen(false);
      setForm(BLANK);
      await refetch();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  async function refund(t: Txn) {
    if (!confirm(`Record a refund of ${formatSignedMoney(t.amountMinor, "INCOME")} for "${t.description}"?`)) return;
    await api.post(`/transactions/${t.id}/refund`, {});
    await refetch();
  }
  async function remove(t: Txn) {
    if (!confirm("Delete this transaction?")) return;
    await api.del(`/transactions/${t.id}`);
    await refetch();
  }

  return (
    <div>
      <PageHeader
        title="Transactions"
        subtitle={data ? `${data.total} transaction(s)` : undefined}
        actions={<button className="btn-primary" onClick={() => { setForm({ ...BLANK, accountId: accounts[0]?.id ?? "" }); setOpen(true); }}>Add transaction</button>}
      />

      <Card className="mb-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <select className="input" value={filters.accountId} onChange={(e) => setFilters({ ...filters, accountId: e.target.value })}>
            <option value="">All accounts</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.nickname}</option>)}
          </select>
          <select className="input" value={filters.direction} onChange={(e) => setFilters({ ...filters, direction: e.target.value })}>
            <option value="">Income &amp; expenditure</option>
            <option value="INCOME">Income only</option>
            <option value="EXPENSE">Expenditure only</option>
            <option value="TRANSFER">Transfers</option>
          </select>
          <input className="input" placeholder="Search description…" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} />
        </div>
      </Card>

      {loading ? (
        <Spinner />
      ) : error ? (
        <EmptyState title="Could not load transactions" hint={error} />
      ) : (data?.items.length ?? 0) === 0 ? (
        <EmptyState title="No transactions found" hint="Add one, or import a CSV from the Imports page." />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3">Account</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {data!.items.map((t) => (
                <tr key={t.id} className="hover:bg-slate-50">
                  <td className="whitespace-nowrap px-4 py-3 text-slate-500">{formatDateUK(t.bookedAt)}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-800">{t.description}</div>
                    {t.merchant && <div className="text-xs text-slate-400">{t.merchant.displayName}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.account.colour }} />
                      {t.account.nickname}
                    </span>
                  </td>
                  <td className="px-4 py-3">{t.category?.name ?? <span className="text-slate-300">—</span>}</td>
                  <td className={`px-4 py-3 text-right font-semibold tabular-nums ${t.direction === "EXPENSE" ? "text-red-600" : t.direction === "INCOME" ? "text-emerald-600" : "text-slate-600"}`}>
                    {formatSignedMoney(t.amountMinor, t.direction)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Badge status={t.status} />
                      {t.direction === "EXPENSE" && t.status !== "REFUNDED" && (
                        <button className="text-xs text-brand-600 hover:underline" onClick={() => refund(t)}>Refund</button>
                      )}
                      <button className="text-xs text-slate-400 hover:text-red-600" onClick={() => remove(t)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Modal open={open} title="Add transaction" onClose={() => setOpen(false)}>
        <form onSubmit={save} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Account">
              <select className="input" value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.nickname}</option>)}
              </select>
            </Field>
            <Field label="Type">
              <select className="input" value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
                <option value="EXPENSE">Expenditure</option>
                <option value="INCOME">Income</option>
              </select>
            </Field>
            <Field label="Amount (£)"><input className="input" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="0.00" /></Field>
            <Field label="Date"><input className="input" type="date" value={form.bookedAt} onChange={(e) => setForm({ ...form, bookedAt: e.target.value })} /></Field>
            <Field label="Category">
              <select className="input" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
                <option value="">Uncategorised</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Merchant"><input className="input" value={form.merchantName} onChange={(e) => setForm({ ...form, merchantName: e.target.value })} placeholder="optional" /></Field>
          </div>
          <Field label="Description"><input className="input" required value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <ErrorText>{formError}</ErrorText>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn-primary">Add transaction</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
