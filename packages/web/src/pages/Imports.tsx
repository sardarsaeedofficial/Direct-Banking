import { useState } from "react";
import { useFetch } from "../api/hooks.js";
import { api, ApiError } from "../api/client.js";
import { Badge, Card, EmptyState, ErrorText, Field, PageHeader } from "../components/ui.js";
import { formatDateTimeUK, formatDateUK, formatMoney } from "../lib/format.js";

interface Account { id: string; nickname: string }
interface PreviewRow { index: number; bookedAt: string | null; description: string; amountMinor: number; direction: string; duplicate: boolean; error?: string }
interface Preview { rows: PreviewRow[]; rowCount: number; duplicateCount: number }
interface Batch { id: string; filename: string | null; status: string; rowCount: number; importedCount: number; duplicateCount: number; createdAt: string }

export default function Imports() {
  const { data: accountsData } = useFetch<{ items: Account[] }>("/accounts");
  const accounts = accountsData?.items ?? [];
  const { data: batchesData, refetch: refetchBatches } = useFetch<{ items: Batch[] }>("/imports");

  const [text, setText] = useState("");
  const [filename, setFilename] = useState<string | undefined>();
  const [accountId, setAccountId] = useState("");
  const [hasHeader, setHasHeader] = useState(true);
  const [dateFormat, setDateFormat] = useState<"DMY" | "MDY" | "YMD">("DMY");
  const [cols, setCols] = useState({ date: 0, description: 1, amount: 2 });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mapping = () => ({ accountId: accountId || accounts[0]?.id, hasHeader, dateFormat, columns: { date: cols.date, description: cols.description, amount: cols.amount } });

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFilename(file.name);
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ""));
    reader.readAsText(file);
  }

  async function doPreview() {
    setError(null);
    setBusy(true);
    try {
      setPreview(await api.post<Preview>("/imports/preview", { text, mapping: mapping() }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Preview failed");
    } finally {
      setBusy(false);
    }
  }

  async function doCommit() {
    setError(null);
    setBusy(true);
    try {
      const res = await api.post<{ imported: number; skipped: number }>("/imports/commit", { text, mapping: mapping(), filename, skipDuplicates: true });
      alert(`Imported ${res.imported} transaction(s), skipped ${res.skipped}.`);
      setPreview(null);
      setText("");
      setFilename(undefined);
      await refetchBatches();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  async function rollback(b: Batch) {
    if (!confirm(`Roll back import of ${b.importedCount} transaction(s)? This deletes them.`)) return;
    await api.post(`/imports/${b.id}/rollback`, {});
    await refetchBatches();
  }

  return (
    <div>
      <PageHeader title="Imports" subtitle="Import bank statement CSVs — preview and check for duplicates before committing" />

      <Card className="mb-6 space-y-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <Field label="Into account">
            <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.nickname}</option>)}
            </select>
          </Field>
          <Field label="Date format">
            <select className="input" value={dateFormat} onChange={(e) => setDateFormat(e.target.value as "DMY" | "MDY" | "YMD")}>
              <option value="DMY">DD/MM/YYYY (UK)</option>
              <option value="MDY">MM/DD/YYYY</option>
              <option value="YMD">YYYY-MM-DD</option>
            </select>
          </Field>
          <Field label="CSV file"><input className="input" type="file" accept=".csv,text/csv" onChange={onFile} /></Field>
          <label className="mt-6 flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} /> First row is a header
          </label>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Date column #"><input className="input" type="number" min={0} value={cols.date} onChange={(e) => setCols({ ...cols, date: Number(e.target.value) })} /></Field>
          <Field label="Description column #"><input className="input" type="number" min={0} value={cols.description} onChange={(e) => setCols({ ...cols, description: Number(e.target.value) })} /></Field>
          <Field label="Amount column # (− = expense)"><input className="input" type="number" min={0} value={cols.amount} onChange={(e) => setCols({ ...cols, amount: Number(e.target.value) })} /></Field>
        </div>

        <Field label="Or paste CSV text">
          <textarea className="input h-28 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder="date,description,amount&#10;20/08/2026,HELIFICA,-85.00" />
        </Field>

        <ErrorText>{error}</ErrorText>
        <div className="flex gap-2">
          <button className="btn-ghost" disabled={!text || busy} onClick={doPreview}>Preview</button>
          <button className="btn-primary" disabled={!preview || busy} onClick={doCommit}>Import{preview ? ` ${preview.rowCount - preview.duplicateCount} new` : ""}</button>
        </div>
      </Card>

      {preview && (
        <Card className="mb-6">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-semibold text-slate-800">Preview</h3>
            <div className="text-sm text-slate-500">{preview.rowCount} rows · <span className="text-amber-600">{preview.duplicateCount} duplicate(s)</span></div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-slate-400"><tr><th className="py-2">Date</th><th className="py-2">Description</th><th className="py-2 text-right">Amount</th><th className="py-2">Flag</th></tr></thead>
              <tbody className="divide-y divide-slate-50">
                {preview.rows.slice(0, 50).map((r) => (
                  <tr key={r.index} className={r.error ? "bg-red-50" : r.duplicate ? "bg-amber-50" : ""}>
                    <td className="py-2">{r.bookedAt ? formatDateUK(r.bookedAt) : "—"}</td>
                    <td className="py-2">{r.description}</td>
                    <td className={`py-2 text-right tabular-nums ${r.direction === "EXPENSE" ? "text-red-600" : "text-emerald-600"}`}>{formatMoney(r.amountMinor)}</td>
                    <td className="py-2 text-xs">{r.error ? <span className="text-red-600">{r.error}</span> : r.duplicate ? <span className="text-amber-600">duplicate</span> : <span className="text-slate-300">ok</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <h3 className="mb-3 font-semibold text-slate-800">Import history</h3>
      {(batchesData?.items.length ?? 0) === 0 ? (
        <EmptyState title="No imports yet" />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 text-left text-xs uppercase text-slate-400"><tr><th className="px-4 py-3">When</th><th className="px-4 py-3">File</th><th className="px-4 py-3">Imported</th><th className="px-4 py-3">Status</th><th className="px-4 py-3"></th></tr></thead>
            <tbody className="divide-y divide-slate-50">
              {batchesData!.items.map((b) => (
                <tr key={b.id}>
                  <td className="px-4 py-3 text-slate-500">{formatDateTimeUK(b.createdAt)}</td>
                  <td className="px-4 py-3">{b.filename ?? "pasted"}</td>
                  <td className="px-4 py-3 tabular-nums">{b.importedCount} / {b.rowCount}</td>
                  <td className="px-4 py-3"><Badge status={b.status} /></td>
                  <td className="px-4 py-3 text-right">
                    {b.status === "COMMITTED" && <button className="text-xs text-red-600 hover:underline" onClick={() => rollback(b)}>Roll back</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
