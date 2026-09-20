// Z.AI throwaway chat-id pool with bounded reuse.
//
// Adapted from GLM-Free-API's session pool (MIT, see THIRD_PARTY_NOTICES.md).
// Z.AI chat IDs are client-generated UUIDs: an unused pooled id never touches
// the upstream account, so pooling has zero network warmup cost.
//
// Upstream (GLM-Free-API 3161e767) found that deleting a chat after every
// single request — one-chat-per-message churn — correlated with edge/WAF
// blocks. So a chat id is now REUSED for up to ZAI_SESSION_REUSE_COUNT (default
// 10) completions before it is deleted and replaced. Reuse across isolated
// full-history requests does not accumulate server-side conversation state.
//
// The gateway-specific difference is multi-account isolation: pools are keyed
// by a stable provider/session identity supplied by the caller.

const DEFAULT_SIZE = Math.max(1, Number(process.env.ZAI_SESSION_POOL_SIZE) || 5);
// 1 = legacy delete-every-request behavior; 10 = current upstream default.
const DEFAULT_REUSE = Math.max(1, Number(process.env.ZAI_SESSION_REUSE_COUNT) || 10);
const pools = new Map();

function makeEntry() {
  return { id: crypto.randomUUID(), uses: 0 };
}

function getPool(key, size, reuse) {
  const id = String(key || "default");
  let pool = pools.get(id);
  if (!pool) {
    const target = Math.max(1, Number(size) || DEFAULT_SIZE);
    const reuseCount = Math.max(1, Number(reuse) || DEFAULT_REUSE);
    pool = { key: id, size: target, reuseCount, ready: [], inFlight: new Map(), acquired: 0, released: 0, retired: 0, reused: 0 };
    while (pool.ready.length < target)
      pool.ready.push(makeEntry());
    pools.set(id, pool);
  }
  return pool;
}

export function acquireZaiChatId(key, size, reuse) {
  const pool = getPool(key, size, reuse);
  // Prefer a still-reusable id from the ready pool; only mint a fresh one when
  // the pool is drained (local-only until a completion references it).
  const entry = pool.ready.shift() || makeEntry();
  pool.inFlight.set(entry.id, entry);
  pool.acquired++;
  return { chatId: entry.id, pooled: true, uses: entry.uses };
}

export function releaseZaiChatId(key, chatId, cleanup) {
  const pool = getPool(key);
  pool.released++;
  if (!chatId)
    return;
  const entry = pool.inFlight.get(chatId);
  if (entry)
    pool.inFlight.delete(chatId);
  const uses = entry ? entry.uses + 1 : Infinity;
  if (entry)
    entry.uses = uses;
  // Bounded reuse: return the same id to the ready pool until it has served
  // reuseCount completions, then delete + replace it. Deleting only every N
  // requests (not every one) is the WAF-churn reduction from upstream.
  if (entry && uses < pool.reuseCount && pool.ready.length < pool.size) {
    pool.reused++;
    pool.ready.push(entry);
    return;
  }
  pool.retired++;
  // Retirement is the only path that actually deletes an upstream chat, and
  // only when a completion may have referenced it. Best-effort, latency-neutral.
  if (typeof cleanup === "function")
    Promise.resolve().then(() => cleanup(chatId)).catch(() => {});
  // Keep the pool populated so the next acquire still has a ready id.
  if (pool.ready.length < pool.size)
    pool.ready.push(makeEntry());
}

export function zaiSessionPoolStatus(key) {
  const shape = (pool) => ({
    key: pool.key,
    size: pool.size,
    reuseCount: pool.reuseCount,
    ready: pool.ready.length,
    inFlight: pool.inFlight.size,
    acquired: pool.acquired,
    released: pool.released,
    reused: pool.reused,
    retired: pool.retired,
    // Per-ready-id remaining reuse budget, so an operator can see churn.
    readyUses: pool.ready.map((e) => e.uses)
  });
  if (key != null) {
    const pool = pools.get(String(key));
    return pool ? shape(pool) : null;
  }
  return [...pools.values()].map(shape);
}

export function resetZaiSessionPools() {
  pools.clear();
}

export const __zaiSessionPoolTest = { getPool, pools, makeEntry };
