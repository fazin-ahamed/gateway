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
