-- AI Gateway D1 schema (SQLite dialect). Apply with:
--   wrangler d1 execute DB --file ai-gateway/schema.sql
-- Secrets are NEVER stored here in plaintext: provider api_key values are
-- AES-GCM envelopes written by the worker (see providerCryptoKey), and admin
-- credentials live in the ADMIN_TOKEN secret, not the database.

CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  healthy INTEGER NOT NULL DEFAULT 1,
  -- Operator off-switch, distinct from runtime health: a disabled provider is
  -- never probed, never routed, and advertises no slugs. The health toggle
  -- marks a provider down but keeps it visible and probed.
  enabled INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  fmt TEXT NOT NULL DEFAULT 'openai',
  proxy_url TEXT,
  transport TEXT NOT NULL DEFAULT 'auto',
  key_strategy TEXT NOT NULL DEFAULT 'round_robin',
  extra_headers TEXT NOT NULL DEFAULT '{}',
  api_key TEXT,
  last_status INTEGER,
  last_checked TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS model_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  upstream_model TEXT NOT NULL,
  rank INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_model_routes_slug_rank
  ON model_routes(slug, rank);

CREATE TABLE IF NOT EXISTS model_tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  models TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  key_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  budget_mode TEXT NOT NULL DEFAULT 'usd',
  budget_limit REAL NOT NULL DEFAULT 0,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  used_usd REAL NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  request_limit_per_minute INTEGER,
  expires_at TEXT,
  allowed_models TEXT,
  excluded_models TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_key_model_tiers (
  key_id TEXT NOT NULL REFERENCES api_keys(key_id) ON DELETE CASCADE,
  tier_id INTEGER NOT NULL REFERENCES model_tiers(id) ON DELETE CASCADE,
  PRIMARY KEY (key_id, tier_id)
);

CREATE TABLE IF NOT EXISTS api_key_rate_windows (
  key_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (key_id, bucket)
);


CREATE TABLE IF NOT EXISTS response_cache (
  cache_key TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  response_body TEXT NOT NULL,
  source_cost_usd REAL NOT NULL DEFAULT 0,
  source_tokens INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS response_cache_locks (
  cache_key TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_tokens (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip
  ON admin_login_attempts(ip_hash, created_at);

CREATE TABLE IF NOT EXISTS prices (
  slug TEXT NOT NULL,
  provider_id INTEGER NOT NULL DEFAULT 0,
  prompt_per_1m REAL NOT NULL DEFAULT 0,
  completion_per_1m REAL NOT NULL DEFAULT 0,
  actual_prompt_per_1m REAL,
  actual_completion_per_1m REAL,
  cache_read_per_1m REAL,
  cache_write_per_1m REAL,
  actual_mode TEXT NOT NULL DEFAULT 'per_1m',
  actual_per_request REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (slug, provider_id)
);

-- Per-request trajectory capture for review, RL, and SFT export.
-- steps_json holds the per-route attempt chain; bodies are capped at
-- ~128KB on write. Capture runs only when gateway_settings row
-- trajectory_capture is not 'off'.
CREATE TABLE IF NOT EXISTS trajectories (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  key_id TEXT,
  key_name TEXT,
  slug TEXT NOT NULL,
  stream INTEGER NOT NULL DEFAULT 0,
  cache_state TEXT,
  status TEXT NOT NULL,
  http_status INTEGER,
  provider TEXT,
  rank INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  steps_json TEXT NOT NULL DEFAULT '[]',
  request_json TEXT,
  response_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_trajectories_created
  ON trajectories(created_at);
CREATE INDEX IF NOT EXISTS idx_trajectories_slug
  ON trajectories(slug);

-- Model-integrity probe runs (`ai-gateway/src/modelprobe.js`): does a provider
-- actually serve the model a route claims? Kept out of `trajectories` on
-- purpose — that table feeds cost/limits and RL/SFT export, and a probe is
-- neither traffic nor a completion. One row per (slug, provider) run; the
-- latest verdict per pair is what the console and the auto-router read.
CREATE TABLE IF NOT EXISTS provider_probe_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  verdict TEXT NOT NULL,
  measured_family TEXT,
  claimed_family TEXT,
  relay_count INTEGER NOT NULL DEFAULT 0,
  exact_fingerprint INTEGER NOT NULL DEFAULT 0,
  signals_json TEXT NOT NULL DEFAULT '[]',
  detail_json TEXT NOT NULL DEFAULT '{}',
  http_status INTEGER,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_probe_runs_slug_provider
  ON provider_probe_runs(slug, provider_id, created_at);

CREATE TABLE IF NOT EXISTS gateway_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Multiple API keys per provider. provider.api_key stays as the legacy
-- single-key column (migrated into this table on boot); new keys live here.
-- Rotation strategy lives on providers.key_strategy:
--   round_robin | failover | random
CREATE TABLE IF NOT EXISTS provider_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  api_key TEXT NOT NULL,
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_keys_provider
  ON provider_keys(provider_id);
-- Global per-model limits. One row per (slug, kind, period):
--   kind   = requests | tokens | usd
--   period = minute | day | week | month
-- No row for a combo means unlimited for it.
CREATE TABLE IF NOT EXISTS model_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  kind TEXT NOT NULL,
  period TEXT NOT NULL,
  limit_value REAL NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(slug, kind, period)
);
CREATE TABLE IF NOT EXISTS model_rate_windows (
  slug TEXT NOT NULL,
  bucket TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (slug, bucket)
);
-- Counters per (slug, kind, bucket). Minute buckets are ISO minute stamps,
-- day/month are ISO date prefixes; week rows are rolled up on write.
CREATE TABLE IF NOT EXISTS model_usage (
  slug TEXT NOT NULL,
  kind TEXT NOT NULL,
  bucket TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, kind, bucket)
);

-- Single-use Aliyun device tokens for the canonical pure-HTTP Z.AI transport.
-- FIFO consumption mirrors GLM-Free-API and prevents token reuse.
CREATE TABLE IF NOT EXISTS zai_device_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- Router V2 posteriors. Shadow path writes nothing yet; table exists so a
-- later live cutover has somewhere to persist Beta(α,β) route health.
CREATE TABLE IF NOT EXISTS router_stats (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  task_type TEXT NOT NULL DEFAULT '',
  success_alpha REAL NOT NULL DEFAULT 8,
  failure_beta REAL NOT NULL DEFAULT 2,
  latency_ema REAL,
  cost_ema REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id, task_type)
);

-- One row per actual upstream attempt (per key, per retry, per fallback), not
-- per request and not per final result. Body-free and safe to keep always-on;
-- it is the authoritative telemetry the router learns route/provider health,
-- latency, and cost from. `health_impact=1` marks operational failures the
-- route posterior should learn from; capability/caller/policy failures do not.
CREATE TABLE IF NOT EXISTS route_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  parent_slug TEXT,
  route_id INTEGER,
  provider_id INTEGER,
  provider_key_id INTEGER,
  public_slug TEXT NOT NULL,
  upstream_model TEXT,
  transport TEXT,
  task_type TEXT,
  attempt_index INTEGER NOT NULL DEFAULT 0,
  key_attempt_index INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  health_impact INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER,
  failure_class TEXT,
  failure_code TEXT,
  ttft_ms INTEGER,
  latency_ms INTEGER,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL,
  actual_cost_usd REAL,
  tool_valid INTEGER,
  tool_success INTEGER,
  verification_score REAL,
  fallback_from_route_id INTEGER,
  rescue_used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_route_attempts_route_time ON route_attempts(route_id, started_at);
CREATE INDEX IF NOT EXISTS idx_route_attempts_provider_time ON route_attempts(provider_id, started_at);
CREATE INDEX IF NOT EXISTS idx_route_attempts_model_task_time ON route_attempts(public_slug, task_type, started_at);
CREATE INDEX IF NOT EXISTS idx_route_attempts_request ON route_attempts(request_id);
CREATE INDEX IF NOT EXISTS idx_zai_device_tokens_fifo
  ON zai_device_tokens(id);
