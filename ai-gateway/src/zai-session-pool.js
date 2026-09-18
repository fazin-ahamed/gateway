// Z.AI throwaway chat-id pool.
//
// Adapted from GLM-Free-API's stateless session pool (MIT, see THIRD_PARTY_NOTICES.md).
// Z.AI chat IDs are client-generated UUIDs: an unused pooled id never touches
// the upstream account. Pooling therefore has zero network warmup cost; its
// value is lifecycle discipline and keeping request handling uniform.
//
// The gateway-specific difference is multi-account isolation: pools are keyed
// by a stable provider/session identity supplied by the caller.

const DEFAULT_SIZE = Math.max(1, Number(process.env.ZAI_SESSION_POOL_SIZE) || 5);
const pools = new Map();

function makeId() {
  return crypto.randomUUID();
}

function getPool(key, size = DEFAULT_SIZE) {
  const id = String(key || "default");
  let pool = pools.get(id);
  if (!pool) {
    const target = Math.max(1, Number(size) || DEFAULT_SIZE);
    pool = { key: id, size: target, ready: [], acquired: 0, released: 0 };
    while (pool.ready.length < target)
      pool.ready.push(makeId());
    pools.set(id, pool);
  }
  return pool;
}

export function acquireZaiChatId(key, size) {
  const pool = getPool(key, size);
  const chatId = pool.ready.shift() || makeId();
  pool.acquired++;
  // Refill immediately: IDs are local-only until a completion references them.
  while (pool.ready.length < pool.size)
    pool.ready.push(makeId());
  return { chatId, pooled: true };
}

export function releaseZaiChatId(key, chatId, cleanup) {
  const pool = getPool(key);
  pool.released++;
  if (!chatId || typeof cleanup !== "function")
    return;
  // Best-effort and latency-neutral, matching the reference's GC semantics.
  Promise.resolve().then(() => cleanup(chatId)).catch(() => {});
}

export function zaiSessionPoolStatus(key) {
  if (key != null) {
    const pool = pools.get(String(key));
    return pool ? { size: pool.size, ready: pool.ready.length, acquired: pool.acquired, released: pool.released } : null;
  }
  return [...pools.values()].map((pool) => ({
    key: pool.key,
    size: pool.size,
    ready: pool.ready.length,
    acquired: pool.acquired,
    released: pool.released
  }));
}

export function resetZaiSessionPools() {
  pools.clear();
}

export const __zaiSessionPoolTest = { getPool, pools };
