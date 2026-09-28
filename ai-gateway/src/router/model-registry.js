// Canonical Model Registry — identity is DATA, never a similarity heuristic.
//
// Two names are the same model ONLY when an explicit alias row says so. No
// punctuation normalization, no "looks similar" merging — a wrong merge
// contaminates quality data permanently and is invisible until it is.
//
// Precedence (attachment #4):
//   1. provider-specific wire/upstream alias (provider_id matches, alias in wire/upstream)
//   2. global explicit upstream alias (alias in wire/upstream, provider_id NULL)
//   3. explicit public-slug alias (alias = publicSlug, provider-scoped then global)
//   4. known catalog mapping (canonical_models.id direct match, or catalog_id alias)
//   5. unresolved raw identity -> null (caller falls back to "raw:" + upstream)

// Known explicit seed data — migrated out of zai-models.js / zaiweb.js so the
// relationship exists as data in one authoritative registry.
export const SEED_CANONICAL_MODELS = [
  {
    id: "glm-5.3-flash",
    family: "glm",
    display_name: "GLM-5.3 Flash",
    reasoning: 1, tools: 1, vision: 1,
    context_limit: 98304, output_limit: 16384
  },
  {
    id: "glm-5.3",
    family: "glm",
    display_name: "GLM-5.3",
    reasoning: 1, tools: 1, vision: 0,
    // Native model capability, verified independently of any transport. A route
    // that cannot deliver this much clamps BELOW it via its own override; the
    // canonical row never absorbs a transport's measured ceiling.
    context_limit: 1000000, output_limit: 131072
  },
  {
    id: "glm-5.2",
    family: "glm",
    display_name: "GLM-5.2",
    reasoning: 1, tools: 1, vision: 0,
    context_limit: 98304, output_limit: 16384
  }
];

export const SEED_MODEL_ALIASES = [
  { alias: "glm-5.3-flash",      canonical_model_id: "glm-5.3-flash", alias_type: "public_slug",    provider_id: null, confidence: 1.0, source: "seed" },
  { alias: "z-ai/glm-5.3-flash", canonical_model_id: "glm-5.3-flash", alias_type: "public_slug",    provider_id: null, confidence: 1.0, source: "seed" },
  { alias: "x-preview-l",        canonical_model_id: "glm-5.3-flash", alias_type: "wire_model",      provider_id: null, confidence: 1.0, source: "seed:zaiweb" },
  { alias: "GLM-5.3-Flash",      canonical_model_id: "glm-5.3-flash", alias_type: "provider_alias",  provider_id: null, confidence: 1.0, source: "seed:zai-models" },
  { alias: "glm-5-3-flash",      canonical_model_id: "glm-5.3-flash", alias_type: "legacy_alias",    provider_id: null, confidence: 1.0, source: "seed:zai-models" },

  { alias: "glm-5.3",            canonical_model_id: "glm-5.3",       alias_type: "public_slug",    provider_id: null, confidence: 1.0, source: "seed" },
  { alias: "z-ai/glm-5.3",       canonical_model_id: "glm-5.3",       alias_type: "public_slug",    provider_id: null, confidence: 1.0, source: "seed" },
  { alias: "GLM-5.3",            canonical_model_id: "glm-5.3",       alias_type: "provider_alias",  provider_id: null, confidence: 1.0, source: "seed" },

  { alias: "glm-5.2",            canonical_model_id: "glm-5.2",       alias_type: "public_slug",    provider_id: null, confidence: 1.0, source: "seed" },
  { alias: "z-ai/glm-5.2",       canonical_model_id: "glm-5.2",       alias_type: "public_slug",    provider_id: null, confidence: 1.0, source: "seed" }
];

// Pure in-memory maps built from the static seed so code paths without a DB
// handle (zaiweb request prep, zai-models live-catalog lookup) ask the
// registry's seed instead of hardcoding their own duplicate mappings.
const SEED_BY_ALIAS = new Map();
const SEED_BY_CANONICAL = new Map();
for (const a of SEED_MODEL_ALIASES) {
  SEED_BY_ALIAS.set(a.alias.toLowerCase(), a.canonical_model_id);
  const list = SEED_BY_CANONICAL.get(a.canonical_model_id) || [];
  list.push(a.alias);
  SEED_BY_CANONICAL.set(a.canonical_model_id, list);
}

// Pure: wire/opaque name -> canonical id from seed (used by zaiweb unprefixedModelId)
export function seedWireToCanonical(name) {
  if (!name) return null;
  return SEED_BY_ALIAS.get(String(name).trim().toLowerCase()) || null;
}

// Pure: any alias -> all sibling spellings sharing that canonical (used by zai-models modelAliases)
export function seedAliasFamily(name) {
  const raw = String(name || "").trim();
  if (!raw) return [];
  const canon = SEED_BY_ALIAS.get(raw.toLowerCase());
  if (!canon) return [raw];
  const list = SEED_BY_CANONICAL.get(canon) || [];
  // Dedup by EXACT string, not case-folded: "glm-5.3-flash" and
  // "GLM-5.3-Flash" are distinct live-catalog keys, and the consumer looks up
  // each spelling against the catalog verbatim. Case-folding here would drop a
  // sibling that only differs in case and silently break catalog resolution.
  const out = [raw];
  for (const a of list) {
    if (!out.includes(a))
      out.push(a);
  }
  return out;
}

// ---------- DB-backed resolution (the authoritative path) ----------

export async function loadAliasIndex(c) {
  try {
    if (!c || !c.env || !c.env.DB) return new Map();
    const r = await c.env.DB.prepare(
      "SELECT alias, canonical_model_id, alias_type, provider_id, confidence FROM model_aliases"
    ).all();
    const rows = (r && r.results) || [];
    const index = new Map();
    for (const row of rows) {
      const k = String(row.alias || "").trim().toLowerCase();
      if (!k) continue;
      const list = index.get(k) || [];
      list.push(row);
      index.set(k, list);
    }
    return index;
  } catch {
    return new Map();
  }
}

// 5-step resolver per attachment #4. Pure over a pre-loaded index (Map of alias_lower -> rows[]).
export function resolveCanonicalModel(index, { providerId = null, publicSlug = "", upstreamModel = "", wireModel = "" } = {}) {
  if (!index || !index.size) return null;
  const pid = providerId == null ? null : Number(providerId);

  const clean = (s) => {
    const v = String(s || "").trim();
    return v || null;
  };
  const wire = clean(wireModel);
  const upstream = clean(upstreamModel);
  const slug = clean(publicSlug);

  const rowsOf = (name) => (name ? index.get(name.toLowerCase()) || [] : []);

  // 1. provider-specific wire/upstream alias
  if (pid != null) {
    for (const name of [wire, upstream].filter(Boolean)) {
      const match = rowsOf(name).find((r) =>
        r.provider_id != null && Number(r.provider_id) === pid &&
        (r.alias_type === "wire_model" || r.alias_type === "upstream_model" || r.alias_type === "provider_alias")
      );
      if (match) return { canonicalModelId: match.canonical_model_id, alias: match, step: 1 };
    }
  }

  // 2. global explicit upstream alias
  for (const name of [wire, upstream].filter(Boolean)) {
    const match = rowsOf(name).find((r) =>
      r.provider_id == null &&
      (r.alias_type === "upstream_model" || r.alias_type === "wire_model" || r.alias_type === "provider_alias" || r.alias_type === "legacy_alias")
    );
    if (match) return { canonicalModelId: match.canonical_model_id, alias: match, step: 2 };
  }

  // 3. explicit public-slug alias (provider-scoped first, then global)
  if (slug) {
    const slugRows = rowsOf(slug);
    if (pid != null) {
      const scoped = slugRows.find((r) => r.provider_id != null && Number(r.provider_id) === pid && r.alias_type === "public_slug");
      if (scoped) return { canonicalModelId: scoped.canonical_model_id, alias: scoped, step: 3 };
    }
    const global = slugRows.find((r) => r.provider_id == null && r.alias_type === "public_slug");
    if (global) return { canonicalModelId: global.canonical_model_id, alias: global, step: 3 };
  }

  // 4. known catalog mapping (catalog_id alias on any of the identities)
  for (const name of [wire, upstream, slug].filter(Boolean)) {
    const match = rowsOf(name).find((r) => r.alias_type === "catalog_id");
    if (match) return { canonicalModelId: match.canonical_model_id, alias: match, step: 4 };
  }

  // 5. unresolved raw identity -> caller falls back to "raw:" + upstream
  return null;
}

// Convenience: single-shot resolution hitting the DB-backed index.
export async function resolveCanonicalModelForRoute(c, { providerId = null, publicSlug = "", upstreamModel = "", wireModel = "" } = {}) {
  const index = await loadAliasIndex(c);
  return resolveCanonicalModel(index, { providerId, publicSlug, upstreamModel, wireModel });
}

// Idempotent seed: writes missing canonical models + aliases into the DB.
// Safe on every boot/test: uses INSERT OR IGNORE, never clobbers operator edits.
export async function seedModelRegistry(c) {
  try {
    if (!c || !c.env || !c.env.DB) return { models: 0, aliases: 0 };
    const now = new Date().toISOString();
    let mCount = 0;
    for (const m of SEED_CANONICAL_MODELS) {
      const r = await c.env.DB.prepare(
        `INSERT OR IGNORE INTO canonical_models
         (id, family, display_name, reasoning, tools, vision, context_limit, output_limit, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).bind(m.id, m.family, m.display_name, m.reasoning, m.tools, m.vision, m.context_limit, m.output_limit, now, now).run();
      if (r && r.meta && r.meta.changes) mCount++;
      // A canonical limit that was seeded too low (a transport ceiling mistaken
      // for the model's own) has to move up. Operator values above the seed are
      // left alone: this only raises a row that is still below the verified seed.
      await c.env.DB.prepare(
        `UPDATE canonical_models
         SET context_limit = CASE WHEN context_limit IS NULL OR context_limit < ? THEN ? ELSE context_limit END,
             output_limit  = CASE WHEN output_limit  IS NULL OR output_limit  < ? THEN ? ELSE output_limit  END,
             updated_at = ?
         WHERE id = ? AND (context_limit IS NULL OR context_limit < ? OR output_limit IS NULL OR output_limit < ?)`
      ).bind(m.context_limit, m.context_limit, m.output_limit, m.output_limit, now, m.id, m.context_limit, m.output_limit).run();
    }
    let aCount = 0;
    for (const a of SEED_MODEL_ALIASES) {
      const r = await c.env.DB.prepare(
        `INSERT OR IGNORE INTO model_aliases
         (alias, canonical_model_id, alias_type, provider_id, confidence, source, created_at)
         VALUES (?,?,?,?,?,?,?)`
      ).bind(a.alias, a.canonical_model_id, a.alias_type, a.provider_id, a.confidence, a.source, now).run();
      if (r && r.meta && r.meta.changes) aCount++;
    }
    return { models: mCount, aliases: aCount };
  } catch (e) {
    console.log("seedModelRegistry failed: " + String(e && e.message || e));
    return { models: 0, aliases: 0, error: String(e && e.message || e) };
  }
}

// Backfill quality_observations.canonical_model_id for historical rows that
// were recorded before #4 landed. Never rewrites signal data — only populates
// the canonical identity when resolved, leaving unresolvable rows NULL.
export async function backfillQualityCanonicalIds(c) {
  try {
    if (!c || !c.env || !c.env.DB) return { scanned: 0, updated: 0 };
    const index = await loadAliasIndex(c);
    const rows = await c.env.DB.prepare(
      "SELECT id, public_slug, upstream_model, provider_id FROM quality_observations WHERE canonical_model_id IS NULL"
    ).all();
    const list = (rows && rows.results) || [];
    let updated = 0;
    for (const r of list) {
      const hit = resolveCanonicalModel(index, { providerId: r.provider_id, publicSlug: r.public_slug, upstreamModel: r.upstream_model });
      if (hit && hit.canonicalModelId) {
        await c.env.DB.prepare(
          "UPDATE quality_observations SET canonical_model_id=? WHERE id=?"
        ).bind(hit.canonicalModelId, r.id).run();
        updated++;
      }
    }
    return { scanned: list.length, updated };
  } catch (e) {
    return { scanned: 0, updated: 0, error: String(e && e.message || e) };
  }
}
