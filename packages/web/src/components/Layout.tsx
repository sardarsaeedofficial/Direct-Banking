import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../store/auth.js";

const NAV: Array<{ to: string; label: string; icon: string }> = [
  { to: "/", label: "Dashboard", icon: "▦" },
  { to: "/transactions", label: "Transactions", icon: "⇄" },
  { to: "/direct-debits", label: "Direct Debits", icon: "↻" },
  { to: "/calendar", label: "Calendar", icon: "◷" },
  { to: "/accounts", label: "Accounts", icon: "▤" },
  { to: "/budgets", label: "Budgets", icon: "◑" },
  { to: "/reports", label: "Reports", icon: "▧" },
  { to: "/imports", label: "Imports", icon: "⇪" },
  { to: "/notifications", label: "Notifications", icon: "◔" },
  { to: "/settings", label: "Settings", icon: "⚙" },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const nav = (
    <nav className="flex flex-col gap-1">
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === "/"}
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
              isActive ? "bg-brand-500 text-white" : "text-slate-600 hover:bg-slate-100"
            }`
          }
        >
          <span className="w-5 text-center text-base opacity-80">{item.icon}</span>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-screen bg-slate-100">
      {/* Sidebar (desktop) */}
      <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white p-4 lg:block">
        <Brand />
        <div className="mt-6">{nav}</div>
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-slate-900/40" />
          <aside className="absolute left-0 top-0 h-full w-64 bg-white p-4" onClick={(e) => e.stopPropagation()}>
            <Brand />
            <div className="mt-6">{nav}</div>
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur lg:px-8">
          <button className="btn-ghost lg:hidden" onClick={() => setOpen(true)} aria-label="Menu">☰</button>
          <div className="hidden text-sm text-slate-500 lg:block">Personal cashflow &amp; direct-debit manager</div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-600">{user?.displayName || user?.email}</span>
            <button
              className="btn-ghost"
              onClick={async () => {
                await logout();
                navigate("/login");
              }}
            >
              Sign out
            </button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 p-4 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-500 text-white">£</div>
      <div>
        <div className="text-sm font-bold leading-tight text-slate-900">Direct Banking</div>
        <div className="text-[11px] text-slate-400">records, never moves money</div>
      </div>
    </div>
  );
}
