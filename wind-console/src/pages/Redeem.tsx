import { useEffect, useState } from "react";
import { WindMark } from "../lib/logo";
import { Button, Input, Label } from "../lib/ui";
import { apiFetch } from "../lib/api";
import { useNavigate } from "react-router-dom";

export function Redeem() {
  const navigate = useNavigate();
  const token = new URLSearchParams(location.search).get("token") || "";
  const [purpose, setPurpose] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) { setBusy(false); return; }
    fetch(`/console/redeem-api?token=${encodeURIComponent(token)}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setPurpose(d?.purpose || null))
      .catch(() => setPurpose(null))
      .finally(() => setBusy(false));
  }, [token]);

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const res = await apiFetch("/console/redeem-api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, username, password })
      });
      if (res.ok) { navigate("/"); return; }
      const d = await res.json().catch(() => ({}));
      setError(d?.error?.message || "Could not use this link.");
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
        {busy ? (
          <p className="text-sm text-muted">Checking this link...</p>
        ) : !purpose ? (
          <>
            <p className="text-sm text-muted">This link is not valid or has expired. Ask for a new one.</p>
            <Button variant="secondary" className="mt-5" onClick={() => navigate("/signin")}>Back to sign in</Button>
          </>
        ) : (
          <>
            <p className="mb-5 text-sm text-muted">{purpose === "invite" ? "You were invited to this gateway. Pick a username and password to finish setting up." : "Reset your password to sign in again."}</p>
            <div className="flex flex-col gap-3">
              {purpose === "invite" && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="ru">Username</Label>
                  <Input id="ru" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rp">New password</Label>
                <Input id="rp" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="at least 8 characters" />
              </div>
              {error && <p className="text-sm text-danger-soft-fg" role="alert">{error}</p>}
              <Button size="lg" className="mt-1 w-full" onClick={submit} disabled={busy || password.length < 8 || (purpose === "invite" && !username)}>
                {busy ? "Working..." : purpose === "invite" ? "Create account" : "Reset password"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
