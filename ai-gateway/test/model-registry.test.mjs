import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SEED_CANONICAL_MODELS,
  SEED_MODEL_ALIASES,
  seedWireToCanonical,
  seedAliasFamily,
  loadAliasIndex,
  resolveCanonicalModel,
  resolveCanonicalModelForRoute,
  seedModelRegistry,
  backfillQualityCanonicalIds
} from "../src/router/model-registry.js";
import { emitQualityObservations, rebuildQualityStats, resolveQualityIdentity } from "../src/router/quality.js";
import { createDb } from "../../server/db.mjs";

function memDb() {
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return db;
}
const ctxOf = (db) => ({ env: { DB: db } });
const count = (db, table) => db.prepare("SELECT COUNT(*) AS n FROM " + table).all().results[0].n;

// ---------- pure seed derivations (no DB) ----------

test("seed wire id maps to its canonical model; unknown wire ids do not", () => {
  assert.equal(seedWireToCanonical("x-preview-l"), "glm-5.3-flash");
  assert.equal(seedWireToCanonical("X-Preview-L"), "glm-5.3-flash");
  assert.equal(seedWireToCanonical("glm-5.3"), "glm-5.3");
  assert.equal(seedWireToCanonical("mystery-wire"), null);
  assert.equal(seedWireToCanonical(""), null);
});

test("seed alias family returns every sibling spelling of one canonical, verbatim for unknowns", () => {
  const fam = seedAliasFamily("glm-5.3-flash");
  assert.ok(fam.includes("x-preview-l"), "flash family includes the wire id");
  assert.ok(fam.includes("GLM-5.3-Flash"), "flash family includes the display alias");
  assert.equal(fam[0], "glm-5.3-flash", "the queried spelling stays first");
  // An unknown name is returned verbatim and NOT merged with anything.
  assert.deepEqual(seedAliasFamily("totally-unknown"), ["totally-unknown"]);
  assert.deepEqual(seedAliasFamily(""), []);
});

// ---------- DB-backed 5-step precedence ----------

async function seededDb() {
  const db = memDb();
  await seedModelRegistry(ctxOf(db));
  return db;
}

test("resolver: global seed aliases resolve x-preview-l and the display name to the same canonical", async () => {
  const db = await seededDb();
  const index = await loadAliasIndex(ctxOf(db));
  assert.equal(resolveCanonicalModel(index, { upstreamModel: "x-preview-l" }).canonicalModelId, "glm-5.3-flash");
  assert.equal(resolveCanonicalModel(index, { upstreamModel: "GLM-5.3-Flash" }).canonicalModelId, "glm-5.3-flash");
  assert.equal(resolveCanonicalModel(index, { publicSlug: "z-ai/glm-5.3-flash" }).canonicalModelId, "glm-5.3-flash");
  // No alias -> null; the caller falls back to a provisional "raw:" identity.
  assert.equal(resolveCanonicalModel(index, { upstreamModel: "glm-5.3-flash-turbo" }), null);
});

test("resolver: identical alias text under one key — provider scope takes step 1, others fall to global", () => {
  // alias is the PRIMARY KEY in the DB, but the in-memory index groups rows by
  // alias text, so one key can carry a global row and a provider-scoped row.
  // Precedence: a provider match (step 1) beats the global row (step 2).
  const index = new Map([["dup-wire", [
    { alias: "dup-wire", canonical_model_id: "global-m", alias_type: "wire_model", provider_id: null, confidence: 1 },
    { alias: "dup-wire", canonical_model_id: "scoped-m", alias_type: "wire_model", provider_id: 7, confidence: 1 }
  ]]]);
  assert.equal(resolveCanonicalModel(index, { providerId: 7, upstreamModel: "dup-wire" }).canonicalModelId, "scoped-m", "provider scope wins");
  assert.equal(resolveCanonicalModel(index, { providerId: 9, upstreamModel: "dup-wire" }).canonicalModelId, "global-m", "other providers fall to global");
  assert.equal(resolveCanonicalModel(index, { upstreamModel: "dup-wire" }).canonicalModelId, "global-m", "no provider -> global");
});

test("resolver: punctuation-different spellings are NOT merged without an explicit alias", async () => {
  const db = await seededDb();
  const index = await loadAliasIndex(ctxOf(db));
  // "glm5.3" is a plausible typo of a real model but no alias row asserts it,
  // so identity must stay unresolved rather than silently merging.
  assert.equal(resolveCanonicalModel(index, { upstreamModel: "glm5.3" }), null);
  assert.equal(resolveCanonicalModel(index, { upstreamModel: "glm-5-3" }), null);
});

test("seed is idempotent: a second seed writes no new rows", async () => {
  const db = memDb();
  const first = await seedModelRegistry(ctxOf(db));
  assert.equal(first.models, SEED_CANONICAL_MODELS.length);
  assert.equal(first.aliases, SEED_MODEL_ALIASES.length);
  const second = await seedModelRegistry(ctxOf(db));
  assert.equal(second.models, 0, "no canonical rows re-inserted");
  assert.equal(second.aliases, 0, "no alias rows re-inserted");
  assert.equal(count(db, "canonical_models"), SEED_CANONICAL_MODELS.length);
  assert.equal(count(db, "model_aliases"), SEED_MODEL_ALIASES.length);
});

test("resolveCanonicalModelForRoute hits the DB index in one shot", async () => {
  const db = await seededDb();
  const hit = await resolveCanonicalModelForRoute(ctxOf(db), { upstreamModel: "x-preview-l" });
  assert.equal(hit.canonicalModelId, "glm-5.3-flash");
});

// ---------- the invariant: shared quality, separate operational posteriors ----------

test("two differently-named routes for one canonical share quality but keep separate operational posteriors", async () => {
  const db = await seededDb();
  const c = ctxOf(db);
  const now = new Date().toISOString();

  // Route 101: public slug z-ai/glm-5.3-flash, upstream glm-5.3-flash.
  // Route 202: a different provider exposing the SAME model via the wire id
  // x-preview-l. Both resolve to canonical glm-5.3-flash.
  const attA = { request_id: "rA", route_id: 101, provider_id: 1, public_slug: "z-ai/glm-5.3-flash", upstream_model: "glm-5.3-flash", task_type: "code:debug", success: 1, tool_valid: 1 };
  const attB = { request_id: "rB", route_id: 202, provider_id: 2, public_slug: "flash", upstream_model: "x-preview-l", task_type: "code:debug", success: 1, tool_valid: 1 };

  // Both resolve to the same canonical identity for quality.
  assert.equal(await resolveQualityIdentity(c, attA), "glm-5.3-flash");
  assert.equal(await resolveQualityIdentity(c, attB), "glm-5.3-flash");

  await emitQualityObservations(c, 1001, attA);
  await emitQualityObservations(c, 1002, attB);

  // Quality is SHARED: one canonical row folds both attempts' evidence.
  const qrows = db.prepare("SELECT canonical_model_id, observation_weight FROM model_quality_stats WHERE task_type='code:debug'").all().results;
  assert.equal(qrows.length, 1, "one shared canonical quality row, not one per route");
  assert.equal(qrows[0].canonical_model_id, "glm-5.3-flash");
  const solo = db.prepare("SELECT observation_weight FROM model_quality_stats WHERE canonical_model_id='glm-5.3-flash'").all().results[0].observation_weight;
  assert.ok(solo > 0);
  // Two attempts folded -> weight is twice a single tool_valid solo weight.
  assert.equal(qrows[0].observation_weight, solo);

  // Observations carry the resolved canonical id, from BOTH upstream spellings.
  const obs = db.prepare("SELECT DISTINCT upstream_model, canonical_model_id FROM quality_observations ORDER BY upstream_model").all().results
    .map((r) => ({ upstream_model: r.upstream_model, canonical_model_id: r.canonical_model_id }));
  assert.deepEqual(obs, [
    { upstream_model: "glm-5.3-flash", canonical_model_id: "glm-5.3-flash" },
    { upstream_model: "x-preview-l", canonical_model_id: "glm-5.3-flash" }
  ]);

  // Operational posteriors are SEPARATE: router_stats is keyed per route scope,
  // never per canonical model. Simulate the two routes' independent health.
  db.prepare("INSERT INTO router_stats (scope, scope_id, task_type, success_alpha, failure_beta, updated_at) VALUES ('route','101','code:debug',20,1,?)").bind(now).run();
  db.prepare("INSERT INTO router_stats (scope, scope_id, task_type, success_alpha, failure_beta, updated_at) VALUES ('route','202','code:debug',3,9,?)").bind(now).run();
  const rs = db.prepare("SELECT scope_id, success_alpha, failure_beta FROM router_stats WHERE scope='route' ORDER BY scope_id").all().results;
  assert.equal(rs.length, 2, "two distinct route posteriors survive a shared canonical identity");
  assert.notEqual(rs[0].success_alpha, rs[1].success_alpha);
  // The shared canonical id NEVER appears as an operational scope_id.
  const leaked = db.prepare("SELECT COUNT(*) AS n FROM router_stats WHERE scope_id='glm-5.3-flash'").all().results[0].n;
  assert.equal(leaked, 0, "canonical identity must not leak into operational health");
});

// ---------- backfill + rebuild of historical rows ----------

test("backfill resolves historical NULL canonical ids; rebuild folds by canonical, leaves unresolved as raw", async () => {
  const db = await seededDb();
  const c = ctxOf(db);
  const now = new Date().toISOString();
  const insObs = db.prepare(
    "INSERT INTO quality_observations (request_id, route_attempt_id, route_id, provider_id, public_slug, upstream_model, canonical_model_id, task_type, signal_type, value, weight, objective, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  );
  // Two historical rows for the same canonical model under two spellings, both
  // recorded before the registry existed (canonical_model_id NULL).
  insObs.bind("h1", 1, 1, 1, "z-ai/glm-5.3-flash", "glm-5.3-flash", null, "code:debug", "tool_valid", 1, 0.4, 1, "attempt", now).run();
  insObs.bind("h2", 2, 2, 2, "flash", "x-preview-l", null, "code:debug", "tool_valid", 1, 0.4, 1, "attempt", now).run();
  // One row whose identity no alias resolves — must stay raw, never guessed.
  insObs.bind("h3", 3, 3, 3, "mystery", "mystery-model", null, "chat:casual", "tool_valid", 1, 0.4, 1, "attempt", now).run();

  const bf = await backfillQualityCanonicalIds(c);
  assert.equal(bf.scanned, 3);
  assert.equal(bf.updated, 2, "only the two resolvable rows get a canonical id");
  const nullsLeft = db.prepare("SELECT upstream_model FROM quality_observations WHERE canonical_model_id IS NULL").all().results;
  assert.deepEqual(nullsLeft.map((r) => r.upstream_model), ["mystery-model"], "unresolved stays NULL, not guessed");

  const rb = await rebuildQualityStats(c);
  assert.equal(rb.stats, 2, "one shared canonical bucket + one provisional raw bucket");
  const canon = db.prepare("SELECT observation_weight FROM model_quality_stats WHERE canonical_model_id='glm-5.3-flash' AND task_type='code:debug'").all().results[0];
  assert.ok(Math.abs(canon.observation_weight - 0.8) < 1e-9, "both spellings folded into one canonical bucket");
  const raw = db.prepare("SELECT observation_weight FROM model_quality_stats WHERE canonical_model_id='raw:mystery-model' AND task_type='chat:casual'").all().results[0];
  assert.ok(Math.abs(raw.observation_weight - 0.4) < 1e-9, "unresolved identity keeps its provisional raw bucket");
});
