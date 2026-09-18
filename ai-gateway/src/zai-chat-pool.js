// Throwaway Z.AI chat-id pool.
//
// Adapted from GLM-Free-API's async session-pool design (MIT; see
// THIRD_PARTY_NOTICES.md). Z.AI chat ids are client-generated UUIDs and only
// materialize when a completion references them, so warmup is local: keep a
// standing batch of fresh ids, retire each used id, then immediately refill.

const pools = new Map();

function clampSize(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.min(100, Math.floor(n)) : 5;
}

export class ZaiChatPool {
  constructor({ size = process.env.ZAI_SESSION_POOL_SIZE || 5, uuid = () => crypto.randomUUID() } = {}) {
    this.size = clampSize(size);
    this.uuid = uuid;
    this.ready = [];
    this.inUse = new Set();
    this.closed = false;
    this._refill();
  }

  _refill() {
    if (this.closed) return;
    while (this.ready.length < this.size)
      this.ready.push(this.uuid());
  }

  acquire() {
    if (this.closed)
      throw new Error("Z.AI chat pool is closed");
    const id = this.ready.shift() || this.uuid();
    this.inUse.add(id);
    this._refill();
    return id;
  }

  retire(id) {
    if (id)
      this.inUse.delete(id);
    this._refill();
  }

  status() {
    return {
      size: this.size,
      ready: this.ready.length,
      inUse: this.inUse.size,
      closed: this.closed
    };
  }

  close() {
    this.closed = true;
    this.ready.length = 0;
    this.inUse.clear();
  }
}

export function chatPoolFor(key = "default", options = {}) {
  const id = String(key || "default");
  const existing = pools.get(id);
  if (existing && !existing.closed)
    return existing;
  const pool = new ZaiChatPool(options);
  pools.set(id, pool);
  return pool;
}

export function resetChatPools() {
  for (const pool of pools.values())
    pool.close();
  pools.clear();
}

export const __chatPoolTest = { pools, clampSize };
