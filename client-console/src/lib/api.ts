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
  budget: { mode: string; limit: number; used: number; remaining: number; request_count: number };
  rate: { per_minute: number; used_this_minute: number };
};

export type Settings = {
  response_cache: { enabled: boolean; entries: number; hits: number; saved_usd: number; saved_tokens: number };
};

export const api = {
  overview: (days: number) => json<Overview>(`/console/api/overview?days=${days}`),
  activity: (hours: number) => json<Activity>(`/console/api/activity?hours=${hours}`),
  limits: () => json<Limits>("/console/api/limits"),
  settings: () => json<Settings>("/console/api/settings"),
  setCache: (on: boolean) =>
    json<{ response_cache: { enabled: boolean } }>("/console/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_cache: on ? "on" : "off" })
    }),
  models: () => json<{ data: ConsoleModel[] }>("/console/api/models"),
  request: (id: string) => json<RequestDetail>(`/console/api/requests/${encodeURIComponent(id)}`)
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
