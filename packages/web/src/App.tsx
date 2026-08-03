import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout.js";
import { useAuth } from "./store/auth.js";
import { Spinner } from "./components/ui.js";
import Login from "./pages/Login.js";
import Dashboard from "./pages/Dashboard.js";
import Transactions from "./pages/Transactions.js";
import DirectDebits from "./pages/DirectDebits.js";
import Calendar from "./pages/Calendar.js";
import Accounts from "./pages/Accounts.js";
import Budgets from "./pages/Budgets.js";
import Reports from "./pages/Reports.js";
import Imports from "./pages/Imports.js";
import Notifications from "./pages/Notifications.js";
import Settings from "./pages/Settings.js";

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/transactions" element={<Transactions />} />
        <Route path="/direct-debits" element={<DirectDebits />} />
        <Route path="/calendar" element={<Calendar />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/budgets" element={<Budgets />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/imports" element={<Imports />} />
        <Route path="/notifications" element={<Notifications />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
