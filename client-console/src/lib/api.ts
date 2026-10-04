// Thin fetch wrappers for the purpose-built client API. Every call rides the
// HttpOnly session cookie; nothing here ever touches an sk- key.

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (res.status === 401) {
    location.assign("/console/signin");
    throw new Error("session expired");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export type Overview = {
  window: { days: number };
  totals: {
    requests: number;
    ok_requests: number;
    tokens: number;
    spend_usd: number;
    p95_ttft_ms: number | null;
  };
  prior_totals: {
    requests: number;
    tokens: number;
    spend_usd: number;
  } | null;
  series: Array<{ day: string; requests: number; tokens: number; spend_usd: number; p95_ttft_ms: number | null }>;
  recent: Array<{
    id: string;
    created_at: string;
    slug: string;
    model_kind: "chat" | "decision";
    status: string;
    http_status: number | null;
    latency_ms: number | null;
    ttft_ms: number | null;
    tokens: number;
    cost_usd: number | null;
  }>;
};

export type ConsoleModel = {
  id: string;
  model_kind: "chat" | "decision";
  protocol?: string | null;
  endpoint?: string | null;
  context_window?: number | null;
  max_output_tokens?: number | null;
  tools?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  routing?: { max_context: number; resilient_context: number; dynamic: boolean } | null;
  prompt_per_1m?: number | null;
  completion_per_1m?: number | null;
  per_request?: number | null;
  price_source?: string | null;
  name?: string | null;
  knowledge?: string | null;
  uptime?: number | null;
  samples?: number;
};

export type RequestDetail = {
  id: string;
  created_at: string;
  slug: string;
  model_kind: "chat" | "decision";
  status: string;
  http_status: number | null;
  stream: boolean;
  headers_ms: number | null;
  ttft_ms: number | null;
  latency_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
  attempts: number | null;
  cache_state: string | null;
  client_app?: string | null;
  headers?: Record<string, string>;
  prompt?: string | null;
};
export type Activity = {
  window: { hours: number };
  totals: { requests: number; ok: number; fail: number; tokens: number; spend_usd: number };
  points: Array<{ hour: string; requests: number; ok: number; fail: number; tokens: number; spend_usd: number }>;
};

export type Limits = {
  name: string;
  active: boolean;
  expires_at: string | null;
  budget: { mode: string; limit: number; used: number; remaining: number | null; request_count: number; uncapped?: boolean };
  rate: { per_minute: number; used_this_minute: number };
  keys?: number;
  // "account" when the cap is the account's; "key" for the legacy 1:1 shape,
  // where the binding limit lives on the account's own key.
  budget_scope?: "account" | "key";
  models: Array<{ slug: string; kind: string; period: string; limit: number; used: number; remaining: number }>;
};

export type Settings = {
  response_cache: { enabled: boolean; entries: number; hits: number; saved_usd: number; saved_tokens: number };
};

export type Pool = {
  key_id: string;
  name: string;
  mode: string;
  limit: number;
  used: number;
  remaining: number;
  request_count: number;
  active: boolean;
} | null;

export type AccountKey = {
  key_id: string;
  name: string;
  active: boolean;
  // True for the account's own key in the legacy 1:1 shape: it predates the
  // account and cannot be recreated if deleted.
  own?: boolean;
  used_usd: number;
  used_tokens: number;
  request_count: number;
  created_at: string;
};
export type Account = {
  username: string;
  budget_mode: string;
  budget_limit: number | null;
  // "key" when the binding cap is the original key's, in the legacy shape.
  budget_scope?: "account" | "key";
  used_usd: number;
  used_tokens: number;
  tiers: Array<{ id: number; name: string }>;
};
export type KeysResponse = { keys: AccountKey[]; account: Account | null };

export const api = {
  overview: (days: number, keyId?: string) =>
    json<Overview>(`/console/api/overview?days=${days}${keyId ? `&key_id=${encodeURIComponent(keyId)}` : ""}`),
  activity: (hours: number) => json<Activity>(`/console/api/activity?hours=${hours}`),
  limits: () => json<Limits>("/console/api/limits"),
  keys: () => json<KeysResponse>("/console/api/keys"),
  createKey: (name: string, budgetLimit?: number | null) =>
    json<{ key_id: string; key: string; name: string }>("/console/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(budgetLimit == null ? { name } : { name, budget_limit: budgetLimit })
    }),
  setKeyActive: (id: string, active: boolean) =>
    json<{ key_id: string; active: boolean }>(`/console/api/keys/${encodeURIComponent(id)}/active`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active })
    }),
  deleteKey: (id: string) =>
    json<{ deleted: string }>(`/console/api/keys/${encodeURIComponent(id)}`, { method: "DELETE" }),
  settings: () => json<Settings>("/console/api/settings"),
  setCache: (on: boolean) =>
    json<{ response_cache: { enabled: boolean } }>("/console/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_cache: on ? "on" : "off" })
    }),
  models: () => json<{ data: ConsoleModel[] }>("/console/api/models"),
  request: (id: string) => json<RequestDetail>(`/console/api/requests/${encodeURIComponent(id)}`),
  pool: () => json<{ pool: Pool }>("/console/api/pool")
};

export function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—";
  return Intl.NumberFormat("en", { notation: n >= 100000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);
}

export function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
}

export function fmtMs(n: number | null | undefined): string {
  if (n == null) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`;
}

export function fmtContext(n: number | null | undefined): string {
  if (!n) return "—";
  return n >= 1024 ? `${Math.round(n / 1024)}k` : String(n);
}
