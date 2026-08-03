import { useState } from "react";
import { api, ApiError } from "../api/client.js";
import { useAuth } from "../store/auth.js";
import { Card, ErrorText, Field, PageHeader } from "../components/ui.js";

export default function Settings() {
  const { user, refresh } = useAuth();
  const [profile, setProfile] = useState({ displayName: user?.displayName ?? "", baseCurrency: user?.baseCurrency ?? "GBP", locale: user?.locale ?? "en-GB" });
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [pw, setPw] = useState({ currentPassword: "", newPassword: "" });
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [twofa, setTwofa] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [totp, setTotp] = useState("");
  const [twofaMsg, setTwofaMsg] = useState<string | null>(null);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setProfileMsg(null);
    try {
      await api.put("/settings/profile", profile);
      await refresh();
      setProfileMsg("Saved.");
    } catch (err) {
      setProfileMsg(err instanceof ApiError ? err.message : "Failed");
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwMsg(null);
    try {
      await api.post("/auth/change-password", pw);
      setPw({ currentPassword: "", newPassword: "" });
      setPwMsg("Password updated. Other sessions were signed out.");
    } catch (err) {
      setPwMsg(err instanceof ApiError ? err.message : "Failed");
    }
  }

  async function start2fa() {
    setTwofaMsg(null);
    setTwofa(await api.post("/auth/2fa/setup"));
  }
  async function enable2fa(e: React.FormEvent) {
    e.preventDefault();
    setTwofaMsg(null);
    try {
      await api.post("/auth/2fa/enable", { totp });
      await refresh();
      setTwofa(null);
      setTotp("");
      setTwofaMsg("Two-factor authentication enabled.");
    } catch (err) {
      setTwofaMsg(err instanceof ApiError ? err.message : "Invalid code");
    }
  }
  async function disable2fa() {
    await api.post("/auth/2fa/disable");
    await refresh();
    setTwofaMsg("Two-factor authentication disabled.");
  }

  return (
    <div>
      <PageHeader title="Settings" subtitle="Profile, security and preferences" />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <h3 className="mb-4 font-semibold text-slate-800">Profile</h3>
          <form onSubmit={saveProfile} className="space-y-3">
            <Field label="Display name"><input className="input" value={profile.displayName} onChange={(e) => setProfile({ ...profile, displayName: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Base currency"><input className="input" maxLength={3} value={profile.baseCurrency} onChange={(e) => setProfile({ ...profile, baseCurrency: e.target.value.toUpperCase() })} /></Field>
              <Field label="Locale"><input className="input" value={profile.locale} onChange={(e) => setProfile({ ...profile, locale: e.target.value })} /></Field>
            </div>
            <div className="flex items-center gap-3">
              <button className="btn-primary">Save profile</button>
              {profileMsg && <span className="text-sm text-slate-500">{profileMsg}</span>}
            </div>
          </form>
        </Card>

        <Card>
          <h3 className="mb-4 font-semibold text-slate-800">Change password</h3>
          <form onSubmit={changePassword} className="space-y-3">
            <Field label="Current password"><input className="input" type="password" required value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>
            <Field label="New password"><input className="input" type="password" required value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} placeholder="At least 10 characters" /></Field>
            <div className="flex items-center gap-3">
              <button className="btn-primary">Update password</button>
              {pwMsg && <span className="text-sm text-slate-500">{pwMsg}</span>}
            </div>
          </form>
        </Card>

        <Card className="lg:col-span-2">
          <h3 className="mb-1 font-semibold text-slate-800">Two-factor authentication</h3>
          <p className="mb-4 text-sm text-slate-500">Optional TOTP authenticator app support (Google Authenticator, 1Password, etc.).</p>
          {user?.twoFactorEnabled ? (
            <div className="flex items-center gap-3">
              <span className="badge bg-emerald-100 text-emerald-700">enabled</span>
              <button className="btn-ghost" onClick={disable2fa}>Disable 2FA</button>
            </div>
          ) : twofa ? (
            <form onSubmit={enable2fa} className="space-y-3">
              <p className="text-sm text-slate-600">Add this secret to your authenticator app, then enter the 6-digit code:</p>
              <code className="block break-all rounded-lg bg-slate-100 px-3 py-2 text-sm">{twofa.secret}</code>
              <div className="flex items-end gap-3">
                <Field label="Code"><input className="input w-40" inputMode="numeric" value={totp} onChange={(e) => setTotp(e.target.value)} placeholder="123456" /></Field>
                <button className="btn-primary">Enable</button>
              </div>
            </form>
          ) : (
            <button className="btn-ghost" onClick={start2fa}>Set up 2FA</button>
          )}
          {twofaMsg && <p className="mt-3 text-sm text-slate-500">{twofaMsg}</p>}
        </Card>
      </div>

      <ErrorText>{null}</ErrorText>
    </div>
  );
}
