import { useState } from "react";
import { useFetch } from "../api/hooks.js";
import { api, ApiError } from "../api/client.js";
import { Card, EmptyState, ErrorText, Field, Modal, PageHeader, Spinner } from "../components/ui.js";
import { formatMoney, toMinor } from "../lib/format.js";
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS } from "../lib/enums.js";

interface Account {
  id: string;
  bankName: string;
  nickname: string;
  accountType: string;
  lastFour: string | null;
  currency: string;
  balanceMinor: number;
  colour: string;
  isArchived: boolean;
}

const BLANK = { bankName: "", nickname: "", accountType: "CURRENT", lastFour: "", balance: "0", colour: "#2563eb" };

export default function Accounts() {
  const { data, loading, error, refetch } = useFetch<{ items: Account[] }>("/accounts");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [form, setForm] = useState(BLANK);
  const [formError, setFormError] = useState<string | null>(null);

  function startAdd() {
    setEditing(null);
    setForm(BLANK);
    setFormError(null);
    setOpen(true);
  }
  function startEdit(a: Account) {
    setEditing(a);
    setForm({ bankName: a.bankName, nickname: a.nickname, accountType: a.accountType, lastFour: a.lastFour ?? "", balance: (a.balanceMinor / 100).toString(), colour: a.colour });
    setFormError(null);
    setOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    try {
      const payload = {
        bankName: form.bankName,
        nickname: form.nickname,
        accountType: form.accountType,
        lastFour: form.lastFour || undefined,
        colour: form.colour,
        balanceMinor: toMinor(form.balance),
      };
      if (editing) await api.put(`/accounts/${editing.id}`, payload);
      else await api.post("/accounts", payload);
      setOpen(false);
      await refetch();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  async function remove(a: Account) {
    if (!confirm(`Remove ${a.nickname}? Accounts with transactions are archived, not deleted.`)) return;
    await api.del(`/accounts/${a.id}`);
    await refetch();
  }

  if (loading) return <Spinner />;
  if (error) return <EmptyState title="Could not load accounts" hint={error} />;

  const items = data?.items ?? [];
  return (
    <div>
      <PageHeader title="Accounts" subtitle="Balances are entered manually — no bank credentials are ever stored" actions={<button className="btn-primary" onClick={startAdd}>Add account</button>} />

      {items.length === 0 ? (
        <EmptyState title="No accounts yet" hint="Add your first account to start tracking." />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((a) => (
            <Card key={a.id} className={a.isArchived ? "opacity-60" : ""}>
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg text-white" style={{ background: a.colour }}>
                    {a.bankName.slice(0, 1)}
                  </div>
                  <div>
                    <div className="font-semibold text-slate-900">{a.nickname}</div>
                    <div className="text-xs text-slate-400">
                      {a.bankName} · {ACCOUNT_TYPE_LABELS[a.accountType]} {a.lastFour ? `· ••${a.lastFour}` : ""}
                    </div>
                  </div>
                </div>
                {a.isArchived && <span className="badge bg-slate-200 text-slate-600">archived</span>}
              </div>
              <div className="mt-4 text-2xl font-bold tabular-nums text-slate-900">{formatMoney(a.balanceMinor, a.currency)}</div>
              <div className="mt-4 flex gap-2">
                <button className="btn-ghost flex-1" onClick={() => startEdit(a)}>Edit</button>
                <button className="btn-ghost" onClick={() => remove(a)}>Remove</button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={open} title={editing ? "Edit account" : "Add account"} onClose={() => setOpen(false)}>
        <form onSubmit={save} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Bank name"><input className="input" required value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} /></Field>
            <Field label="Nickname"><input className="input" required value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} /></Field>
            <Field label="Type">
              <select className="input" value={form.accountType} onChange={(e) => setForm({ ...form, accountType: e.target.value })}>
                {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{ACCOUNT_TYPE_LABELS[t]}</option>)}
              </select>
            </Field>
            <Field label="Last 4 digits"><input className="input" maxLength={4} value={form.lastFour} onChange={(e) => setForm({ ...form, lastFour: e.target.value.replace(/\D/g, "") })} placeholder="optional" /></Field>
            <Field label="Balance (£)"><input className="input" value={form.balance} onChange={(e) => setForm({ ...form, balance: e.target.value })} /></Field>
            <Field label="Colour"><input className="input h-10 p-1" type="color" value={form.colour} onChange={(e) => setForm({ ...form, colour: e.target.value })} /></Field>
          </div>
          <ErrorText>{formError}</ErrorText>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn-primary">{editing ? "Save changes" : "Add account"}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
