// Live chat.z.ai model registry.
//
// Which models a Z.AI account can actually use varies per account (tier), so a
// static table is a fallback, not the truth. This asks the site with the
// session's cookies and caches the answer briefly.

const MODELS_URL = "https://chat.z.ai/api/models";
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function pick(obj, keys) {
  for (const key of keys) {
    const value = obj && obj[key];
    if (value !== undefined && value !== null && value !== "")
      return value;
  }
  return undefined;
}

function asBool(value) {
  if (typeof value === "boolean")
    return value;
  if (typeof value === "string")
    return /^(true|1|yes|on)$/i.test(value.trim());
  if (typeof value === "number")
    return value !== 0;
  return undefined;
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// The models payload shape is not contractual; find arrays of objects that
// look like model rows instead of hardcoding a path.
function findModelRows(value, depth = 0, seen = new Set()) {
  if (!value || depth > 5 || typeof value !== "object" || seen.has(value))
    return [];
  seen.add(value);
  if (Array.isArray(value)) {
    const rows = value.filter((item) => item && typeof item === "object" &&
      typeof pick(item, ["id", "model", "model_id", "name", "slug"]) === "string");
    if (rows.length)
      return rows;
    for (const item of value) {
      const nested = findModelRows(item, depth + 1, seen);
      if (nested.length)
        return nested;
    }
    return [];
  }
  for (const item of Object.values(value)) {
    const nested = findModelRows(item, depth + 1, seen);
    if (nested.length)
      return nested;
  }
  return [];
}

export function normalizeModels(payload) {
  const out = new Map();
  for (const row of findModelRows(payload)) {
    const rawId = pick(row, ["id", "model", "model_id", "name", "slug"]);
    if (typeof rawId !== "string" || !rawId.trim())
      continue;
    const id = rawId.trim();
    const caps = (row.capabilities && typeof row.capabilities === "object") ? row.capabilities : row;
    const thinking = asBool(pick(caps, ["thinking", "reasoning", "enable_thinking", "deep_think", "supports_reasoning"]));
    const vision = asBool(pick(caps, ["vision", "image", "supports_vision", "multimodal", "vlm"]));
    const available = asBool(pick(row, ["available", "enabled", "is_available", "usable", "access"])) ?? true;
    const context = asNumber(pick(caps, ["context_length", "context_window", "context", "max_context", "max_context_tokens"]));
    const output = asNumber(pick(caps, ["max_tokens", "max_output", "output", "max_output_tokens"]));
    out.set(id, {
      id,
      displayName: String(pick(row, ["display_name", "displayName", "label", "title", "name"]) || id),
      available,
      reasoning: thinking === true,
      toolCall: asBool(pick(caps, ["tools", "tool_call", "function_calling"])) === true,
      attachment: vision === true,
      modalities: { input: vision === true ? ["text", "image"] : ["text"], output: ["text"] },
      limit: { context: context || 0, output: output || 0 },
      raw: row
    });
  }
  return out;
}
function modelAliases(id) {
  const raw = String(id || "").trim();
  const lower = raw.toLowerCase();
  const out = [raw];
  if (lower === "glm-5.3-flash" || lower === "glm-5-3-flash")
    out.push("x-preview-l", "GLM-5.3-Flash");
  if (lower === "x-preview-l")
    out.push("glm-5.3-flash", "GLM-5.3-Flash");
  return [...new Set(out)];
}
export class ZaiModelRegistry {
  constructor({ session, fetcher, ttlMs = DEFAULT_TTL_MS, fallback = () => null } = {}) {
    this.session = session;
    this.fetcher = fetcher;
    this.ttlMs = ttlMs;
    this.fallback = fallback;
    this.catalog = null;
    this.at = 0;
    this.error = "";
    this.pending = null;
  }

  status() {
    return {
      live: !!this.catalog,
      models: this.catalog ? this.catalog.size : 0,
      ageMs: this.at ? Date.now() - this.at : null,
      error: this.error
    };
  }

  async list({ force = false } = {}) {
    if (this.catalog && !force && Date.now() - this.at < this.ttlMs)
      return this.catalog;
    if (this.pending)
      return this.pending;
    this.pending = this._fetch(force).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  async _fetch(force) {
    try {
      const session = this.session ? await this.session.acquire() : null;
      const headers = this.session
        ? this.session.headers({ Accept: "application/json" })
        : { Accept: "application/json" };
      const res = await this.fetcher(MODELS_URL, { method: "GET", headers });
      if (this.session)
        this.session.noteResponse(res.headers);
      if (!res.ok) {
        this.error = "models HTTP " + res.status;
        return this.catalog;
      }
      const body = await res.json().catch(() => null);
      const catalog = normalizeModels(body);
      if (!catalog.size) {
        this.error = "models payload had no recognizable rows";
        return this.catalog;
      }
      this.catalog = catalog;
      this.at = Date.now();
      this.error = "";
      return this.catalog;
    } catch (e) {
      this.error = String(e && e.message || e).slice(0, 200);
      return this.catalog;
    } finally {
      void force;
    }
  }

  // Live entry wins; the static fallback only covers fields the site omits.
  // chat.z.ai lists glm-5.3-flash as the opaque id x-preview-l, so look up
  // both the public slug and the wire id before declaring the account
  // cannot see the model.
  async resolve(modelId) {
    const id = String(modelId || "").split("/").pop().trim();
    const aliases = modelAliases(id);
    const base = this.fallback(id) || this.fallback(aliases[0]) || null;
    const catalog = await this.list();
    let live = null;
    if (catalog) {
      for (const alias of aliases) {
        live = catalog.get(alias);
        if (live) break;
      }
      if (!live) {
        const want = id.toLowerCase();
        for (const [key, row] of catalog) {
          const name = String(row.displayName || "").toLowerCase();
          if (key.toLowerCase() === want || name.replace(/\s+/g, "-") === want || name.includes("flash") && want.includes("flash")) {
            live = row;
            break;
          }
        }
      }
    }
    if (!live && catalog && catalog.size) {
      return base ? { ...base, available: false, source: "live" } : null;
    }
    if (!live)
      return base ? { ...base, available: base.available !== false, source: "fallback" } : null;
    return {
      id: "zai-web/" + id,
      wireId: live.id,
      reasoning: live.reasoning || (base ? base.reasoning : false),
      toolCall: live.toolCall || false,
      attachment: live.attachment || false,
      modalities: live.modalities,
      limit: {
        context: live.limit.context || (base ? base.limit.context : 0),
        output: live.limit.output || (base ? base.limit.output : 0)
      },
      available: live.available,
      source: "live"
    };
  }
}

const registries = new Map();

export function registryFor({ session, fetcher, fallback, ttlMs } = {}) {
  const key = (session && session.key) || "default";
  const existing = registries.get(key);
  if (existing) {
    existing.fetcher = fetcher || existing.fetcher;
    existing.session = session || existing.session;
    existing.fallback = fallback || existing.fallback;
    return existing;
  }
  const registry = new ZaiModelRegistry({ session, fetcher, fallback, ttlMs });
  registries.set(key, registry);
  return registry;
}

export function resetRegistries() {
  registries.clear();
}

export const __modelsTest = { registries, MODELS_URL };