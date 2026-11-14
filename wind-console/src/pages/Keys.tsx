import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmtInt, fmtUsd } from "../lib/api";
import { Button, Chip, Input, Label, Modal, Switch, Tooltip, useToast } from "../lib/ui";

export function Keys() {
  const qc = useQueryClient();
  const toast = useToast();
  const keys = useQuery({ queryKey: ["keys"], queryFn: api.keys });
  const [name, setName] = useState("");
  const [cap, setCap] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const rows = keys.data?.keys || [];

  async function create() {
    if (!name.trim()) return;
    const limit = cap.trim() === "" ? null : Number(cap);
    if (limit != null && (!Number.isFinite(limit) || limit <= 0)) { toast("The cap must be positive, or left blank", "danger"); return; }
    const r = await api.createKey(name.trim(), limit);
    setCreated(r.key_id);
    setName("");
    setCap("");
    qc.invalidateQueries({ queryKey: ["keys"] });
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  }

  return (
    <div>
      <h1 className="text-[26px] font-semibold tracking-tight">Keys</h1>
      <p className="mt-1 text-sm text-muted">API keys this account can use against /v1. The account caps apply on top of any per-key cap.</p>

      {keys.data?.account && (
        <div className="mt-6 flex flex-wrap items-center gap-3 rounded-[20px] bg-surface p-5 shadow-[var(--surface-shadow)]">
          <div>
            <div className="text-sm text-muted">Signed in as</div>
            <div className="font-medium">{keys.data.account.username}</div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Chip variant="default">{fmtUsd(keys.data.account.used_usd)} used</Chip>
            {keys.data.account.tiers.map((t) => <Chip key={t.id} variant="accent">{t.name}</Chip>)}
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-3 rounded-[20px] bg-surface p-5 shadow-[var(--surface-shadow)]">
        <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
          <Label htmlFor="kn">Name</Label>
          <Input id="kn" placeholder="laptop, ci, shared" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex w-[180px] flex-col gap-1.5">
          <Label htmlFor="kc">Cap (USD, optional)</Label>
          <Input id="kc" inputMode="decimal" placeholder="blank for no cap" value={cap} onChange={(e) => setCap(e.target.value)} />
        </div>
        <Button onClick={create} disabled={!name.trim()}>Create key</Button>
      </div>

      {created && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-success-soft px-4 py-3 text-sm text-success-soft-fg" role="status">
          <span>This key is shown once. Store it somewhere safe: <code className="font-mono">{created}</code></span>
          <Button size="sm" variant="secondary" onClick={() => { copy(created); setCreated(null); }}>Copy and close</Button>
        </div>
      )}

      <div className="mt-4 overflow-x-auto rounded-[20px] bg-surface shadow-[var(--surface-shadow)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-2 text-xs text-muted">
              <th className="rounded-tl-[20px] px-4 py-2.5 text-start font-medium">Name</th>
              <th className="px-4 py-2.5 text-start font-medium">Key</th>
              <th className="px-4 py-2.5 text-end font-medium">Used</th>
              <th className="px-4 py-2.5 text-end font-medium">Requests</th>
              <th className="px-4 py-2.5 text-start font-medium">Active</th>
              <th className="rounded-tr-[20px] px-4 py-2.5 text-end font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((k) => (
              <tr key={k.key_id} className="border-b border-separator last:border-0">
                <td className="px-4 py-3 font-medium">{k.name}{k.own && <Chip className="ml-2" variant="accent">original</Chip>}</td>
                <td className="px-4 py-3 font-mono text-xs">
                  <Tooltip content="Click to copy">
                    <button className="text-muted transition-colors hover:text-foreground" onClick={() => copy(k.key_id)}>{k.key_id.slice(0, 12)}...</button>
                  </Tooltip>
                </td>
                <td className="px-4 py-3 text-end font-mono tabular-nums">{fmtUsd(k.used_usd)}</td>
                <td className="px-4 py-3 text-end font-mono tabular-nums">{fmtInt(k.request_count)}</td>
                <td className="px-4 py-3">
                  <Switch checked={k.active} onChange={(v) => { api.setKeyActive(k.key_id, v).then(() => qc.invalidateQueries({ queryKey: ["keys"] })); }} />
                </td>
                <td className="px-4 py-3 text-end">
                  {!k.own && (
                    <Button size="sm" variant="danger-soft" onClick={() => setConfirmDelete(k.key_id)}>Delete</Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Delete this key?">
        <p className="text-sm text-muted">Clients using it stop working immediately. This cannot be undone.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="tertiary" onClick={() => setConfirmDelete(null)}>Keep it</Button>
          <Button variant="danger" onClick={async () => { await api.deleteKey(confirmDelete!); setConfirmDelete(null); qc.invalidateQueries({ queryKey: ["keys"] }); toast("Key deleted"); }}>Delete</Button>
        </div>
      </Modal>
    </div>
  );
}
