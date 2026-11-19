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
  enabled INTEGER NOT NULL DEFAULT 1,
  -- 'chat' models answer /chat/completions. 'decision' models answer a
  -- structured decision endpoint (/v1/systemone) and must never be selected
  -- as an Auto answer generator. wire_format overrides the provider default
  -- so one provider can host several model kinds.
  model_kind TEXT NOT NULL DEFAULT 'chat',
  wire_format TEXT,
  endpoint_path TEXT,
  -- A route may deliver less than the canonical model can. NULL inherits the
  -- canonical limit; a positive number clamps this transport below it. Zero is
  -- not a limit and is rejected on write. A route can never claim more than
  -- the model itself supports.
  context_limit_override INTEGER,
  output_limit_override INTEGER,
  -- Kind-specific overlays (image sizes, video durations) live here as JSON so
  -- media kinds don't each grow their own columns. Empty means inherit.
  capability_overrides_json TEXT NOT NULL DEFAULT '{}'
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
  console_auth INTEGER NOT NULL DEFAULT 1,
  response_cache INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- The console account that minted this key. NULL for operator-created keys,
  -- which have no account and no shared spend cap.
  account_id TEXT REFERENCES console_accounts(key_id) ON DELETE CASCADE
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

-- Client-console sessions: an API key exchanged once for an HttpOnly cookie.
-- The key itself is never stored in the browser. Each row records which
-- api_keys row owns the session so /console/api/* can attribute queries.
CREATE TABLE IF NOT EXISTS console_sessions (
  token_hash TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS console_accounts (
  key_id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- The account is the customer. Spend across every key it owns is capped
  -- here; individual keys only track their own usage. NULL means no cap.
  budget_mode TEXT NOT NULL DEFAULT 'usd',
  budget_limit REAL,
  used_usd REAL NOT NULL DEFAULT 0,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  -- Rolling-window caps (24 hours, 30 days) and prepaid credits. NULL cap
  -- means no cap for that window; credits never reset and only cover spend
  -- that overruns a capped window. See src/budgets.js.
  budget_daily_usd REAL,
  budget_monthly_usd REAL,
  credits_usd REAL NOT NULL DEFAULT 0
);
-- Append-only spend ledger behind the rolling windows. Pruned past 31 days.
CREATE TABLE IF NOT EXISTS spend_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  request_id TEXT,
  usd REAL NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spend_events_account_at ON spend_events(account_id, at);
-- Model tiers granted to the whole account. Keys the account creates inherit
-- these and cannot widen them.
CREATE TABLE IF NOT EXISTS console_account_tiers (
  key_id TEXT NOT NULL REFERENCES console_accounts(key_id) ON DELETE CASCADE,
  tier_id INTEGER NOT NULL REFERENCES model_tiers(id) ON DELETE CASCADE,
  PRIMARY KEY (key_id, tier_id)
);
-- Single-use tokens for password resets and account creation invites.
-- purpose 'reset' re-credentials an existing console_accounts row;
-- 'invite' lets a new person set up their account without a key being handed
-- over. One row per issued token: consumed on use, revocable while pending.
CREATE TABLE IF NOT EXISTS console_account_tokens (
  token_hash TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  purpose TEXT NOT NULL,  -- 'reset' | 'invite'
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  budget_mode TEXT,
  budget_limit REAL,
  tier_ids TEXT
);
CREATE INDEX IF NOT EXISTS idx_account_tokens_key
  ON console_account_tokens(key_id, purpose);

-- Always-on, body-free per-request ledger. This is the customer-facing
-- operational truth: Overview, Requests and Usage read it, and it records
-- chat and decision traffic through the same lifecycle. trajectories is
-- OPTIONAL body capture (debugging, training, Vey) and route_attempts holds
-- internal attempt detail; neither is a billing/accounting source. If an
-- operator disables trajectory capture, nothing here changes.
CREATE TABLE IF NOT EXISTS request_summaries (
  request_id TEXT PRIMARY KEY,
  key_id TEXT,
  model_kind TEXT NOT NULL,
  public_slug TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  http_status INTEGER,
  stream INTEGER NOT NULL DEFAULT 0,
  cache_state TEXT,
  headers_ms INTEGER,
  ttft_ms INTEGER,
  latency_ms INTEGER,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  client_app TEXT,
  request_headers TEXT
);
CREATE INDEX IF NOT EXISTS idx_request_summaries_key_time
  ON request_summaries(key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_summaries_slug_time
  ON request_summaries(public_slug, created_at);

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
  headers_ms INTEGER,
  latency_ms INTEGER,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL,
  actual_cost_usd REAL,
  tool_valid INTEGER,
  tool_success INTEGER,
  verification_score REAL,
  fallback_from_route_id INTEGER,
  rescue_used INTEGER NOT NULL DEFAULT 0,
  -- Router V2 shadow experiment (nullable; only the FINAL serving attempt of
  -- an auto-routed request carries these). The dual decision is recorded once
  -- per request so "how often would quality change the choice?" is answerable
  -- from real traffic. Route IDs, not slugs: operational stats/cost/latency are
  -- route-specific while quality is canonical-model-specific. Body-free.
  v2_operational_route_id INTEGER,
  v2_quality_route_id INTEGER,
  v2_quality_changed INTEGER,
  v2_quality_state TEXT,
  v2_quality_reason TEXT,
  v2_reliability_floor REAL,
  v2_quality_floor REAL
);
CREATE INDEX IF NOT EXISTS idx_route_attempts_route_time ON route_attempts(route_id, started_at);
CREATE INDEX IF NOT EXISTS idx_route_attempts_provider_time ON route_attempts(provider_id, started_at);
CREATE INDEX IF NOT EXISTS idx_route_attempts_model_task_time ON route_attempts(public_slug, task_type, started_at);
CREATE INDEX IF NOT EXISTS idx_route_attempts_request ON route_attempts(request_id);

-- Quality observations: evidence about the ANSWER itself, kept strictly
-- separate from the operational outcomes in route_attempts/router_stats.
-- A bare 200 NEVER creates a quality-success observation here — rows appear
-- only when something spoke about the response (a tool call that validated
-- and executed, a verifier score, explicit user feedback). value is always
-- normalized to 0..1; weight is the epistemic mass of the signal (objective
-- execution evidence > user feedback > model-graded judgement).
-- canonical_model_id stays NULL until the canonical model registry lands,
-- which will also backfill it; until then identity is provisional.
CREATE TABLE IF NOT EXISTS quality_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  route_attempt_id INTEGER,
  route_id INTEGER,
  provider_id INTEGER,
  public_slug TEXT,
  upstream_model TEXT,
  canonical_model_id TEXT,
  task_type TEXT NOT NULL DEFAULT '',
  signal_type TEXT NOT NULL,
  value REAL NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  objective INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(request_id, route_attempt_id, signal_type, source)
);
CREATE INDEX IF NOT EXISTS idx_quality_model_task ON quality_observations(canonical_model_id, task_type, created_at);
CREATE INDEX IF NOT EXISTS idx_quality_upstream ON quality_observations(upstream_model, task_type, created_at);
CREATE INDEX IF NOT EXISTS idx_quality_route ON quality_observations(route_id, created_at);

-- Canonical model registry — the one place that knows which names mean the
-- same intelligence. Two routes serving the same canonical model share
-- answer-quality learning (model_quality_stats); they never share operational
-- posteriors, latency, cost, or credential health (those stay route-level in
-- router_stats). Identity is DATA, never a similarity heuristic: two names
-- are the same model only when an explicit alias row says so — no punctuation
-- normalization pretending two spellings are one model.
CREATE TABLE IF NOT EXISTS canonical_models (
  id TEXT PRIMARY KEY,
  family TEXT,
  display_name TEXT,
  reasoning INTEGER,
  tools INTEGER,
  vision INTEGER,
  context_limit INTEGER,
  output_limit INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- alias_type separates fundamentally different identities:
--   public_slug | upstream_model | wire_model | catalog_id | provider_alias | legacy_alias
-- provider_id NULL means the alias is global; a provider-scoped alias wins
-- over a global one (resellers can reuse generic upstream names for different
-- models). alias is the PRIMARY KEY: one name, one canonical meaning.
CREATE TABLE IF NOT EXISTS model_aliases (
  alias TEXT PRIMARY KEY,
  canonical_model_id TEXT NOT NULL,
  alias_type TEXT NOT NULL,
  provider_id INTEGER,
  confidence REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(canonical_model_id) REFERENCES canonical_models(id)
);
CREATE INDEX IF NOT EXISTS idx_model_aliases_canonical ON model_aliases(canonical_model_id);
CREATE INDEX IF NOT EXISTS idx_model_aliases_provider ON model_aliases(provider_id);

-- Derived cache over quality_observations — rebuildable, never authoritative.
-- Fractional Beta(2,2) updates: alpha += weight*value, beta += weight*(1-value).
-- The prior is deliberately unconfident (unlike the operational route prior):
-- "unmeasured" must look unmeasured, not 50%-confident. SHADOW-ONLY: routing
-- must not read this table until calibration is reviewed.
-- Keyed by canonical_model_id once the registry resolves the alias; an
-- unresolved identity keeps the provisional "raw:<upstream_model>" verbatim
-- key until it is resolved. Rebuilt from quality_observations by the admin
-- rebuild endpoint, never mathematically merged from old Beta rows.
CREATE TABLE IF NOT EXISTS model_quality_stats (
  canonical_model_id TEXT NOT NULL,
  task_type TEXT NOT NULL DEFAULT '',
  quality_alpha REAL NOT NULL DEFAULT 2,
  quality_beta REAL NOT NULL DEFAULT 2,
  observation_weight REAL NOT NULL DEFAULT 0,
  objective_weight REAL NOT NULL DEFAULT 0,
  subjective_weight REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(canonical_model_id, task_type)
);

-- Egress proxy inventory for the Z.AI uTLS helper. Credentials are AES-GCM
-- envelopes written by the worker (same providerCryptoKey machinery as
-- provider api_key), never plaintext. status is the explicit lifecycle:
--   untested | healthy | flaky | dead | disabled
-- Raw counters are kept alongside status so the UI never has to infer it.
-- One helper process still owns one sticky egress at runtime; this table is
-- inventory + connectivity health, not a per-request rotation pool.
CREATE TABLE IF NOT EXISTS proxy_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheme TEXT NOT NULL,              -- http | https | socks5 | socks5h
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  password_enc TEXT,                 -- AES-GCM envelope, never plaintext
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'untested',
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_latency_ms INTEGER,
  last_failure_class TEXT,
  last_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Identity is scheme+host+port+username: the same host on two schemes or
  -- two accounts are distinct proxies.
  UNIQUE(scheme, host, port, username)
);
CREATE INDEX IF NOT EXISTS idx_proxy_pool_status ON proxy_pool(status);

-- Per-check outcome metadata (no bodies): lets a route tell "failed once" from
-- "98.7% reliable over 400 checks".
CREATE TABLE IF NOT EXISTS proxy_test_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proxy_id INTEGER NOT NULL REFERENCES proxy_pool(id) ON DELETE CASCADE,
  success INTEGER NOT NULL DEFAULT 0,
  failure_class TEXT,
  connect_ms INTEGER,
  tunnel_ms INTEGER,
  tls_ms INTEGER,
  total_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proxy_test_runs_proxy ON proxy_test_runs(proxy_id, created_at);

-- Agent-loop repetition telemetry for the Z.AI agent shim. One row per agent
-- completion (a single tool round). Body-free: reasoning is stored ONLY as a
-- hash-set fingerprint (reasoning_fp), never as text. reasoning_prefix_overlap
-- is the Jaccard similarity of this round's opening reasoning against the
-- PREVIOUS round of the same logical_turn_id — it quantifies whether the model
-- is re-deriving the same reasoning instead of continuing. tool_calls_repeated
-- is the stateless companion signal: a call re-issued after it was already made
-- and answered. Used to measure the continuation-prompt fix before/after.
CREATE TABLE IF NOT EXISTS agent_loop_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  logical_turn_id TEXT NOT NULL,
  public_slug TEXT,
  upstream_model TEXT,
  task_type TEXT NOT NULL DEFAULT '',
  agent_round INTEGER NOT NULL DEFAULT 1,
  continuation_mode TEXT NOT NULL DEFAULT 'first_turn',
  tool_exchanges_in_history INTEGER NOT NULL DEFAULT 0,
  tool_results_in_history INTEGER NOT NULL DEFAULT 0,
  tool_calls_emitted INTEGER NOT NULL DEFAULT 0,
  tool_calls_repeated INTEGER NOT NULL DEFAULT 0,
  reasoning_chars INTEGER NOT NULL DEFAULT 0,
  reasoning_prefix_overlap REAL,
  reasoning_fp TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_loop_turn ON agent_loop_events(logical_turn_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_loop_time ON agent_loop_events(created_at);

-- Immutable decision snapshot: what the policy knew and chose AT DECISION
-- TIME. Body-free (no prompt, no sessionBlob, no source code — those live in
-- trajectories.request_json when capture is explicitly enabled).
--
-- Exists so the Vey exporter never has to reconstruct a historical candidate
-- set from today's model_routes. Routes change price, health, circuit state,
-- posteriors and capabilities over time; exporting a request from yesterday
-- against today's route table would manufacture fake training data.
--
-- candidate_set_json is the full set the policy considered, INCLUDING
-- rejected candidates: a learned decision model must see "this option
-- existed but failed the reliability floor", not only the options that
-- passed. propensity stays NULL while the policy is deterministic — do not
-- invent one; record the real value only if randomized exploration ships.
--
-- Written once per auto request by recordRouterDecision, before any upstream
-- attempt. Explicit-model requests write nothing. The row is what the policy
-- scored at decision time, rejected candidates included.
CREATE TABLE IF NOT EXISTS router_decisions (
  request_id TEXT PRIMARY KEY,

  policy_name TEXT NOT NULL,
  policy_version TEXT NOT NULL,

  task_type TEXT,
  task_ir_version TEXT,

  context_features_json TEXT,
  candidate_set_json TEXT NOT NULL,

  selected_action_id TEXT,

  propensity REAL,
  exploration INTEGER NOT NULL DEFAULT 0,
  decision_type TEXT NOT NULL DEFAULT 'deterministic',

  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_router_decisions_created ON router_decisions(created_at);

-- What the latency governor WOULD have done. Written once per auto request,
-- after the serving route is known and updated when the attempt finishes.
-- Observational: nothing here launches a request. Body-free.
CREATE TABLE IF NOT EXISTS latency_shadow_decisions (
  request_id TEXT PRIMARY KEY,
  primary_route_id INTEGER NOT NULL,
  primary_provider_id INTEGER,
  primary_slug TEXT,
  backup_route_id INTEGER,
  backup_provider_id INTEGER,
  backup_slug TEXT,
  task_type TEXT,
  context_bucket TEXT,
  deadline_ms INTEGER NOT NULL,
  baseline_ms REAL,
  baseline_samples INTEGER NOT NULL DEFAULT 0,
  deadline_source TEXT NOT NULL,
  observed_headers_ms INTEGER,
  observed_ttft_ms INTEGER,
  would_hedge INTEGER,
  hedge_possible INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

-- Optional taste layer: per (model, rule) Beta posterior over "did the
-- response satisfy this rule". alpha/beta start at 1/1. See src/taste.js.
CREATE TABLE IF NOT EXISTS taste_posteriors (
  slug TEXT NOT NULL,
  rule TEXT NOT NULL,
  alpha REAL NOT NULL DEFAULT 1,
  beta REAL NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (slug, rule)
);
