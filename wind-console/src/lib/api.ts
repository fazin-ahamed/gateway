// Thin client over the console session cookie. Nothing here touches an sk- key.
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, { credentials: "include", ...init });
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (res.status === 401) {
    location.assign("/console/signin");
    throw new Error("session expired");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  return body as T;
}

export type RollingWindow = {
  id: "24h" | "30d";
  label: string;
  hours: number;
  limit_usd: number | null;
  spent_usd: number;
  remaining_usd: number | null;
  resets_at: string | null;
  resets_in_s: number | null;
};
export type Rolling = {
  enabled: boolean;
  windows: RollingWindow[];
  credits: { balance_usd: number };
  fallback_price: { prompt_per_1m: number; completion_per_1m: number };
  binding: "none" | "window" | "credits" | "exhausted";
};
export type Limits = {
  name: string;
  active: boolean;
  budget: { mode: string; limit: number; used: number; remaining: number | null; request_count: number; uncapped?: boolean };
  rate: { per_minute: number; used_this_minute: number };
  keys?: number;
  budget_scope?: "account" | "key";
  models: Array<{ slug: string; kind: string; period: string; limit: number; used: number; remaining: number }>;
  rolling?: Rolling | null;
};
export type Activity = {
  window: { hours: number };
  totals: { requests: number; ok: number; fail: number; tokens: number; spend_usd: number };
  points: Array<{ hour: string; requests: number; ok: number; fail: number; tokens: number; spend_usd: number }>;
};
export type Model = {
  id: string;
  model_kind: "chat" | "decision";
  kinds?: string[];
  protocol?: string | null;
  endpoint?: string | null;
  context_window?: number | null;
  max_output_tokens?: number | null;
  tools?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  prompt_per_1m?: number | null;
  completion_per_1m?: number | null;
  per_request?: number | null;
  price_source?: string | null;
  name?: string | null;
  knowledge?: string | null;
  uptime?: number | null;
  samples?: number;
};
export type RequestRow = {
  id: string;
  created_at: string;
  slug: string;
  model_kind: string;
  status: string;
  http_status: number | null;
  latency_ms: number | null;
  tokens: number;
  cost_usd: number;
};
export type UsageRow = { slug: string; model_kind: string; requests: number; ok: number; tokens: number; spend_usd: number; p50_ttft_ms: number | null; p95_ttft_ms: number | null };
export type AccountKey = { key_id: string; name: string; active: boolean; own?: boolean; used_usd: number; used_tokens: number; request_count: number; created_at: string };
export type KeysResponse = { keys: AccountKey[]; account: { username: string; budget_mode: string; budget_limit: number | null; budget_scope?: string; used_usd: number; used_tokens: number; tiers: Array<{ id: number; name: string }> } | null };
export type Settings = { response_cache: { enabled: boolean; entries: number; hits: number; saved_usd: number; saved_tokens: number } };
export type Pool = { key_id: string; name: string; mode: string; limit: number; used: number; remaining: number; request_count: number; active: boolean } | null;
export type PlaygroundState = { settings: Record<string, unknown>; chats: Array<{ id: string; title: string; model: string | null; created_at: string; updated_at: string }> };
export type SavedChat = { id: string; title: string; model: string | null; messages: ChatMessage[]; created_at: string; updated_at: string };
export type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; reasoning?: string; tool_calls?: unknown[] };
export type TasteRule = { mean: number; n: number };
export type Taste = {
  taste: number | null;
  samples: number;
  rules: Record<string, TasteRule>;
  models: Record<string, { rules: Record<string, TasteRule>; samples: number }>;
  trend: Array<{ hour: string; score: number; n: number }>;
};
export type TasteVerdict = { at: string; account_id: string; slug: string; score: number; violations: string[] };

export const api = {
  me: () => json<{ key: { key_id: string; name: string } }>("/console/api/me"),
  limits: () => json<Limits>("/console/api/limits"),
  activity: (hours: number) => json<Activity>(`/console/api/activity?hours=${hours}`),
  models: () => json<{ data: Model[] }>("/console/api/models"),
  pool: () => json<{ pool: Pool }>("/console/api/pool"),
  keys: () => json<KeysResponse>("/console/api/keys"),
  createKey: (name: string, budgetLimit?: number | null) =>
    json<{ key_id: string }>("/console/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(budgetLimit == null ? { name } : { name, budget_limit: budgetLimit }) }),
  setKeyActive: (id: string, active: boolean) =>
    json(`/console/api/keys/${encodeURIComponent(id)}/active`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ active }) }),
  deleteKey: (id: string) => json(`/console/api/keys/${encodeURIComponent(id)}`, { method: "DELETE" }),
  settings: () => json<Settings>("/console/api/settings"),
  setCache: (on: boolean) =>
    json("/console/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response_cache: on ? "on" : "off" }) }),
  requests: (days: number, limit = 25, keyId?: string) => json<{ requests: RequestRow[] }>(`/console/api/requests?days=${days}&limit=${limit}${keyId ? `&key_id=${encodeURIComponent(keyId)}` : ""}`),
  request: (id: string) => json(`/console/api/requests/${encodeURIComponent(id)}`),
  usage: (days: number, keyId?: string) => json<{ window: { days: number }; models: UsageRow[] }>(`/console/api/usage?days=${days}${keyId ? `&key_id=${encodeURIComponent(keyId)}` : ""}`),
  playground: () => json<PlaygroundState>("/console/api/playground"),
  savePlaygroundSettings: (settings: Record<string, unknown>) =>
    json("/console/api/playground", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings }) }),
  playgroundChat: (id: string) => json<SavedChat>(`/console/api/playground/chats/${encodeURIComponent(id)}`),
  savePlaygroundChat: (chat: { id: string; title: string; model: string | null; messages: ChatMessage[] }) =>
    json("/console/api/playground/chats", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chat) }),
  deletePlaygroundChat: (id: string) => json(`/console/api/playground/chats/${encodeURIComponent(id)}`, { method: "DELETE" }),
  systemone: (body: unknown) =>
    json("/console/playground/systemone", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  taste: () => json<Taste>("/console/api/taste"),
  tasteVerdicts: () => json<{ verdicts: TasteVerdict[] }>("/console/api/taste/verdicts")
};

export function fmtInt(n: number | null | undefined): string {
  if (n == null) return "-";
  return Intl.NumberFormat("en", { notation: n >= 100000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);
}
export function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "-";
  return `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
}
export function fmtMs(n: number | null | undefined): string {
  if (n == null) return "-";
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`;
}
export function fmtCountdown(seconds: number | null | undefined): string {
  if (seconds == null) return "";
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m` : "<1m";
}
