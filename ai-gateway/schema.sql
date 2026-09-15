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
  slug TEXT PRIMARY KEY,
  prompt_per_1m REAL NOT NULL DEFAULT 0,
  completion_per_1m REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  updated_at TEXT NOT NULL
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
