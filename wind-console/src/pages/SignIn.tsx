import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { WindMark } from "../lib/logo";
import { Button, Input, Label, Modal } from "../lib/ui";
import { useQueryClient } from "@tanstack/react-query";

export function SignIn() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [view, setView] = useState<"login" | "key">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [confirm, setConfirm] = useState("");

  async function post(path: string, body: unknown) {
    const res = await apiFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  async function login(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await post("/console/auth", { username, password });
      if (r.ok) { qc.clear(); navigate("/"); return; }
      setError(r.data?.error?.message || "Sign-in failed.");
    } catch {
      setError("Could not reach the gateway.");
    } finally {
      setBusy(false);
    }
  }

  async function submitKey(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await post("/console/auth", { api_key: apiKey });
      if (r.data?.setup) { setShowCreate(true); return; }
      if (r.ok) { qc.clear(); navigate("/"); return; }
      setError(r.data?.error?.message || "That key did not work.");
    } catch {
      setError("Could not reach the gateway.");
    } finally {
      setBusy(false);
    }
  }

  async function createAccount(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) { setError("The password needs at least 8 characters."); return; }
    if (password !== confirm) { setError("The passwords do not match."); return; }
    setBusy(true);
    try {
      const r = await post("/console/account", { api_key: apiKey, username, password });
      if (r.ok) { qc.clear(); navigate("/"); return; }
      setError(r.data?.error?.message || "Could not create the account.");
    } catch {
      setError("Could not reach the gateway.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center p-6">
      <div className="w-full max-w-[400px] rounded-[24px] bg-surface p-9 shadow-[var(--surface-shadow)]">
        <div className="mb-6 flex items-center gap-2.5">
          <WindMark size={30} className="text-accent" />
          <h1 className="text-[22px] font-semibold tracking-tight">Wind</h1>
        </div>
        {view === "login" ? (
          <>
            <p className="mb-5 text-sm text-muted">Sign in with your username and password.</p>
            <form onSubmit={login} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="user">Username</Label>
                <Input id="user" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pass">Password</Label>
                <Input id="pass" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
              </div>
              {error && <p className="text-sm text-danger-soft-fg" role="alert">{error}</p>}
              <Button type="submit" size="lg" className="mt-1 w-full" disabled={busy}>{busy ? "Signing in..." : "Sign in"}</Button>
            </form>
            <button type="button" onClick={() => { setView("key"); setError(""); }} className="mt-4 text-sm text-muted transition-colors hover:text-foreground">
              First time here? Set up with your API key
            </button>
          </>
        ) : (
          <>
            <p className="mb-5 text-sm text-muted">Enter your gateway API key to set up this account. The key is exchanged for a session and never stored in the browser.</p>
            <form onSubmit={submitKey} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="key">API key</Label>
                <Input id="key" type="password" autoComplete="off" placeholder="sk-..." value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={busy} />
              </div>
              {error && <p className="text-sm text-danger-soft-fg" role="alert">{error}</p>}
              <Button type="submit" size="lg" className="mt-1 w-full" disabled={busy}>{busy ? "Checking..." : "Continue"}</Button>
            </form>
            <button type="button" onClick={() => { setView("login"); setError(""); }} className="mt-4 text-sm text-muted transition-colors hover:text-foreground">
              Already have an account? Sign in
            </button>
          </>
        )}
      </div>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Create your account">
        <p className="mb-4 text-sm text-muted">This key is new here. Pick a username and password. Next time, sign in with those, no key needed.</p>
        <form onSubmit={createAccount} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-user">Username</Label>
            <Input id="new-user" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} placeholder="observatory" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-pass">Password</Label>
            <Input id="new-pass" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} placeholder="at least 8 characters" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-confirm">Confirm password</Label>
            <Input id="new-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy} />
          </div>
          {error && <p className="text-sm text-danger-soft-fg" role="alert">{error}</p>}
          <Button type="submit" size="lg" className="mt-1 w-full" disabled={busy}>{busy ? "Working..." : "Create account"}</Button>
        </form>
      </Modal>
    </div>
  );
}
