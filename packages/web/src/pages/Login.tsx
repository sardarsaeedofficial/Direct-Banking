import { useState } from "react";
import { useAuth } from "../store/auth.js";
import { ApiError } from "../api/client.js";
import { ErrorText, Field } from "../components/ui.js";

export default function Login() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [totp, setTotp] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") await login(email, password, totp || undefined);
      else await register(email, password, displayName || undefined);
    } catch (err) {
      if (err instanceof ApiError && (err.details as { twoFactorRequired?: boolean })?.twoFactorRequired) {
        setNeedsTotp(true);
        setError("Enter your authentication code to continue.");
      } else {
        setError(err instanceof ApiError ? err.message : "Something went wrong");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 to-brand-50 p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-500 text-xl font-bold text-white">£</div>
          <div>
            <div className="text-lg font-bold text-slate-900">Direct Banking</div>
            <div className="text-xs text-slate-500">Your money, clearly forecast</div>
          </div>
        </div>

        <form onSubmit={submit} className="card space-y-4 p-6">
          <div className="flex rounded-lg bg-slate-100 p-1 text-sm font-medium">
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`flex-1 rounded-md py-1.5 transition ${mode === m ? "bg-white shadow-sm" : "text-slate-500"}`}
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
              >
                {m === "login" ? "Sign in" : "Create account"}
              </button>
            ))}
          </div>

          {mode === "register" && (
            <Field label="Name">
              <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your name" />
            </Field>
          )}
          <Field label="Email">
            <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </Field>
          <Field label="Password">
            <input
              className="input"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              placeholder={mode === "register" ? "At least 10 characters" : ""}
            />
          </Field>
          {needsTotp && (
            <Field label="Authentication code">
              <input className="input" inputMode="numeric" value={totp} onChange={(e) => setTotp(e.target.value)} placeholder="6-digit code" />
            </Field>
          )}

          <ErrorText>{error}</ErrorText>

          <button className="btn-primary w-full" disabled={busy}>
            {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
          <p className="text-center text-xs text-slate-400">Direct Banking records and forecasts payments. It never moves money.</p>
        </form>
      </div>
    </div>
  );
}
