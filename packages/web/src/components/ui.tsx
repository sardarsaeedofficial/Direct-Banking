import type { ReactNode } from "react";
import { formatMoney } from "../lib/format.js";
import { STATUS_BADGE } from "../lib/enums.js";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card p-5 ${className}`}>{children}</div>;
}

export function StatTile({ label, minor, hint, tone = "default" }: { label: string; minor: number; hint?: string; tone?: "default" | "positive" | "negative" | "warning" }) {
  const toneClass =
    tone === "positive" ? "text-emerald-600" : tone === "negative" ? "text-red-600" : tone === "warning" ? "text-amber-600" : "text-slate-900";
  return (
    <Card>
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-2 text-2xl font-bold tabular-nums ${toneClass}`}>{formatMoney(minor)}</div>
      {hint && <div className="mt-1 text-xs text-slate-400">{hint}</div>}
    </Card>
  );
}

export function Money({ minor, className = "" }: { minor: number; className?: string }) {
  return <span className={`tabular-nums ${className}`}>{formatMoney(minor)}</span>;
}

export function Badge({ status }: { status: string }) {
  return <span className={`badge ${STATUS_BADGE[status] ?? "bg-slate-100 text-slate-600"}`}>{status.replace(/_/g, " ").toLowerCase()}</span>;
}

export function Spinner() {
  return (
    <div className="flex items-center justify-center py-16 text-slate-400">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-brand-500" />
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <Card className="text-center">
      <p className="font-medium text-slate-700">{title}</p>
      {hint && <p className="mt-1 text-sm text-slate-400">{hint}</p>}
    </Card>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{children}</p> : null;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

export function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4" onClick={onClose}>
      <div className="mt-10 w-full max-w-lg card p-6" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <button className="text-slate-400 hover:text-slate-600" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
