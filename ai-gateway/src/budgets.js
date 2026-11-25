// Rolling-window budgets and prepaid credits for console accounts.
//
// Spend is read from spend_events, an append-only table written at settlement,
// not from the request ledger: the ledger swallows write failures and is a
// reporting surface, while a budget has to be exact. Windows are truly rolling
// (now - window), so there is no reset instant to game; the only "reset" the
// customer sees is when the oldest spend in the window ages out.
//
// Admission is optimistic. Cost is known only after a response, so one request
// can overshoot a cap by its own cost. Credits cover the overshoot at
// settlement, and the next admission is blocked.

export const WINDOWS = [
  { id: "24h", label: "Last 24 hours", hours: 24, column: "budget_daily_usd" },
  { id: "30d", label: "Last 30 days", hours: 720, column: "budget_monthly_usd" }
];

const HOUR_MS = 3600000;
export const DEFAULT_FALLBACK = { prompt_per_1m: 4, completion_per_1m: 4 };
const RETENTION_MS = 31 * 24 * HOUR_MS;

const ensured = new WeakSet();
const lastPrune = new WeakMap();

// Idempotent, same shape as the other ensureXColumns guards: a host database
// that predates this feature must not 500 on the first account request.
export async function ensureBudgetSchema(db) {
  if (!db || ensured.has(db)) return;
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS spend_events (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, key_id TEXT NOT NULL, request_id TEXT, usd REAL NOT NULL, at TEXT NOT NULL)"
  ).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_spend_events_account_at ON spend_events(account_id, at)").run();
  const cols = await db.prepare("PRAGMA table_info(console_accounts)").all();
  const names = new Set((cols.results || []).map((r) => r.name));
  if (names.size) {
    if (!names.has("budget_daily_usd")) await db.prepare("ALTER TABLE console_accounts ADD COLUMN budget_daily_usd REAL").run();
    if (!names.has("budget_monthly_usd")) await db.prepare("ALTER TABLE console_accounts ADD COLUMN budget_monthly_usd REAL").run();
    if (!names.has("credits_usd")) await db.prepare("ALTER TABLE console_accounts ADD COLUMN credits_usd REAL NOT NULL DEFAULT 0").run();
  }
  ensured.add(db);
}

function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

function capOf(row, column) {
  if (!row || row[column] == null) return null;
  const v = Number(row[column]);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

export async function loadAccountBudget(db, accountId) {
  if (!accountId) return null;
  await ensureBudgetSchema(db);
  const row = await db.prepare(
    "SELECT key_id, username, budget_daily_usd, budget_monthly_usd, credits_usd FROM console_accounts WHERE key_id=?"
  ).bind(accountId).first();
  if (!row) return null;
  return {
    key_id: row.key_id,
    username: row.username,
    budget_daily_usd: capOf(row, "budget_daily_usd"),
    budget_monthly_usd: capOf(row, "budget_monthly_usd"),
    credits_usd: Math.max(0, money(row.credits_usd))
  };
}

// Spent and reset time for both windows in one indexed pass. The two SUMs
// differ only by their cutoff, so a single scan over (account_id, at) with a
// conditional aggregate replaces two round trips on the hot path.
async function windowSpends(db, accountId, nowMs) {
  const oldest = new Date(nowMs - Math.max(...WINDOWS.map((w) => w.hours)) * HOUR_MS).toISOString();
  const row = await db.prepare(
    "SELECT " + WINDOWS.map((w) => {
      const cutoff = new Date(nowMs - w.hours * HOUR_MS).toISOString();
      return `COALESCE(SUM(CASE WHEN at > '${cutoff}' THEN usd END),0) AS spent_${w.id}, ` +
        `MIN(CASE WHEN at > '${cutoff}' AND usd > 0 THEN at END) AS first_${w.id}`;
    }).join(", ") + " FROM spend_events WHERE account_id=? AND at > ?"
  ).bind(accountId, oldest).first();
  return Object.fromEntries(WINDOWS.map((w) => [w.id, {
    spent: money(row && row["spent_" + w.id]),
    firstAt: row && row["first_" + w.id] ? String(row["first_" + w.id]) : null
  }]));
}

export async function windowStatuses(db, budget, nowMs = Date.now()) {
  // No caps configured and no credits to cover an overshoot: the windows are
  // all "uncapped, unlimited", so skip the spend scan entirely.
  if (WINDOWS.every((w) => capOf(budget, w.column) == null) && !(budget.credits_usd > 0)) {
    return WINDOWS.map((w) => ({
      id: w.id, label: w.label, hours: w.hours,
      limit_usd: null, spent_usd: 0, remaining_usd: null, resets_at: null, resets_in_s: null
    }));
  }
  const spends = await windowSpends(db, budget.key_id, nowMs);
  const out = [];
  for (const w of WINDOWS) {
    const limit = capOf(budget, w.column);
    const { spent, firstAt } = spends[w.id];
    let resetsAt = null;
    let resetsIn = null;
    if (firstAt && spent > 0) {
      const t = Date.parse(firstAt) + w.hours * HOUR_MS;
      resetsAt = new Date(t).toISOString();
      resetsIn = Math.max(0, Math.round((t - nowMs) / 1000));
    }
    out.push({
      id: w.id,
      label: w.label,
      hours: w.hours,
      limit_usd: limit,
      spent_usd: spent,
      remaining_usd: limit == null ? null : Math.max(0, limit - spent),
      resets_at: resetsAt,
      resets_in_s: resetsIn
    });
  }
  return out;
}

export function bindingOf(windows, credits) {
  const capped = windows.filter((w) => w.limit_usd != null);
  if (!capped.length) return "none";
  const blocked = capped.some((w) => w.remaining_usd <= 0);
  if (!blocked) return "window";
  return credits > 0 ? "credits" : "exhausted";
}

// Status from an already-loaded budget row, so the auth path can reuse the
// account it read for the spend-limit check instead of re-querying it.
export async function rollingStatusFor(db, budget, nowMs = Date.now()) {
  if (!budget) return null;
  const windows = await windowStatuses(db, budget, nowMs);
  return {
    enabled: windows.some((w) => w.limit_usd != null) || budget.credits_usd > 0,
    windows,
    credits: { balance_usd: budget.credits_usd },
    binding: bindingOf(windows, budget.credits_usd)
  };
}

export async function rollingStatus(db, accountId, nowMs = Date.now()) {
  return rollingStatusFor(db, await loadAccountBudget(db, accountId), nowMs);
}

// Decide whether the next request may start from a preloaded budget row.
export async function checkAdmissionFor(db, budget, nowMs = Date.now()) {
  const status = await rollingStatusFor(db, budget, nowMs);
  if (!status || status.binding === "none" || status.binding === "window" || status.binding === "credits")
    return { allowed: true, status };
  const blocked = status.windows
    .filter((w) => w.limit_usd != null && w.remaining_usd <= 0)
    .sort((a, b) => (a.resets_in_s ?? 0) - (b.resets_in_s ?? 0))[0];
  return {
    allowed: false,
    status,
    window: blocked.id,
    resets_at: blocked.resets_at,
    retry_after_s: Math.max(1, blocked.resets_in_s ?? 60)
  };
}

export async function checkAdmission(db, accountId, nowMs = Date.now()) {
  return checkAdmissionFor(db, await loadAccountBudget(db, accountId), nowMs);
}

// Record spend and move any overshoot onto credits. Overflow is measured
// against the tightest capped window as it stood BEFORE this event.
export async function settleSpend(db, { accountId, keyId, requestId, usd }, nowMs = Date.now()) {
  const cost = money(usd);
  if (!accountId || cost <= 0) return { debited: 0 };
  const budget = await loadAccountBudget(db, accountId);
  if (!budget) return { debited: 0 };
  const windows = await windowStatuses(db, budget, nowMs);
  await db.prepare("INSERT INTO spend_events (account_id, key_id, request_id, usd, at) VALUES (?,?,?,?,?)")
    .bind(accountId, keyId || accountId, requestId || null, cost, new Date(nowMs).toISOString()).run();
  await pruneSpendEvents(db, nowMs);
  const capped = windows.filter((w) => w.limit_usd != null);
  if (!capped.length || budget.credits_usd <= 0) return { debited: 0 };
  const headroom = Math.max(0, Math.min(...capped.map((w) => w.remaining_usd)));
  const overflow = Math.max(0, cost - headroom);
  if (overflow <= 0) return { debited: 0 };
  const debit = Math.min(overflow, budget.credits_usd);
  await db.prepare("UPDATE console_accounts SET credits_usd = MAX(0, credits_usd - ?) WHERE key_id=?").bind(debit, accountId).run();
  return { debited: debit };
}

async function pruneSpendEvents(db, nowMs) {
  const last = lastPrune.get(db) || 0;
  if (nowMs - last < HOUR_MS) return;
  lastPrune.set(db, nowMs);
  try {
    await db.prepare("DELETE FROM spend_events WHERE at < ?").bind(new Date(nowMs - RETENTION_MS).toISOString()).run();
  } catch {
    // Pruning is housekeeping; a failure must never fail a settlement.
  }
}

export async function getFallbackPrice(db) {
  try {
    const rows = await db.prepare(
      "SELECT key, value FROM gateway_settings WHERE key IN ('fallback_prompt_per_1m','fallback_completion_per_1m')"
    ).all();
    const map = Object.fromEntries((rows.results || []).map((r) => [r.key, Number(r.value)]));
    const pick = (k, d) => (Number.isFinite(map[k]) && map[k] >= 0 ? map[k] : d);
    return {
      prompt_per_1m: pick("fallback_prompt_per_1m", DEFAULT_FALLBACK.prompt_per_1m),
      completion_per_1m: pick("fallback_completion_per_1m", DEFAULT_FALLBACK.completion_per_1m)
    };
  } catch {
    return { ...DEFAULT_FALLBACK };
  }
}

export async function setFallbackPrice(db, price) {
  const at = new Date().toISOString();
  const upsert = "INSERT INTO gateway_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at";
  await db.prepare(upsert).bind("fallback_prompt_per_1m", String(price.prompt_per_1m), at).run();
  await db.prepare(upsert).bind("fallback_completion_per_1m", String(price.completion_per_1m), at).run();
}

export function fallbackCost(usage, price) {
  const p = Math.max(0, Number(usage && usage.prompt_tokens) || 0);
  const c = Math.max(0, Number(usage && usage.completion_tokens) || 0);
  return (p * price.prompt_per_1m + c * price.completion_per_1m) / 1e6;
}

// Admin patch validation. Returns { error } or { patch } so the route can stay
// a thin wrapper. Caps may be null (clear) or a finite number >= 0.
export function parseBudgetPatch(body) {
  const patch = {};
  const b = body && typeof body === "object" ? body : {};
  for (const field of ["budget_daily_usd", "budget_monthly_usd"]) {
    if (!(field in b)) continue;
    if (b[field] === null || b[field] === "") { patch[field] = null; continue; }
    const n = Number(b[field]);
    if (!Number.isFinite(n) || n < 0) return { error: field + " must be a number >= 0, or null to clear the cap" };
    patch[field] = n;
  }
  if ("credits_usd" in b) {
    const n = Number(b.credits_usd);
    if (!Number.isFinite(n) || n < 0) return { error: "credits_usd must be a number >= 0" };
    patch.credits_usd = n;
  }
  if ("credits_add_usd" in b) {
    const n = Number(b.credits_add_usd);
    if (!Number.isFinite(n)) return { error: "credits_add_usd must be a number" };
    patch.credits_add_usd = n;
  }
  if (!Object.keys(patch).length) return { error: "No budget fields supplied" };
  return { patch };
}

export async function applyBudgetPatch(db, accountId, patch) {
  await ensureBudgetSchema(db);
  const sets = [];
  const binds = [];
  for (const field of ["budget_daily_usd", "budget_monthly_usd"]) {
    if (field in patch) { sets.push(field + "=?"); binds.push(patch[field]); }
  }
  if ("credits_usd" in patch) { sets.push("credits_usd=?"); binds.push(patch.credits_usd); }
  else if ("credits_add_usd" in patch) { sets.push("credits_usd=MAX(0, credits_usd + ?)"); binds.push(patch.credits_add_usd); }
  await db.prepare("UPDATE console_accounts SET " + sets.join(", ") + " WHERE key_id=?").bind(...binds, accountId).run();
}
