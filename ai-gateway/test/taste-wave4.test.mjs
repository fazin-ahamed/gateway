// Wave 4: posteriors keyed per (slug, rule, route) with decay.

import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../../server/db.mjs";
import { updatePosteriors, loadTasteReport, ensureTasteSchema } from "../src/taste.js";

test("posteriors are keyed per (slug, rule, route), not just (slug, rule)", async () => {
  const db = createDb(":memory:");
  await ensureTasteSchema(db);
  await updatePosteriors(db, "m", [{ rule: "json_valid", pass: true }], "route-a");
  await updatePosteriors(db, "m", [{ rule: "json_valid", pass: false }], "route-b");
  const report = await loadTasteReport(db);
  assert.equal(report.length, 1);
  assert.equal(report[0].slug, "m");
  // The report aggregates across routes; per-route rows exist in the table.
  const rows = (await db.prepare("SELECT slug, rule, route, alpha, beta FROM taste_posteriors ORDER BY route").all()).results || [];
  assert.equal(rows.length, 2, "one row per route");
  assert.equal(rows[0].route, "route-a");
  assert.equal(rows[1].route, "route-b");
});

test("decay halves old evidence after the half-life", async () => {
  const db = createDb(":memory:");
  await ensureTasteSchema(db);
  // Insert an old observation manually with a backdated updated_at.
  const old = new Date(Date.now() - 30 * 86400000).toISOString(); // 30 days ago
  await db.prepare("INSERT INTO taste_posteriors (slug, rule, route, alpha, beta, updated_at) VALUES (?,?,?,?,?,?)")
    .bind("m", "json_valid", "route-a", 11, 1, old).run(); // 10 passes, 0 fails, 30 days old
  // Add a fresh failure.
  await updatePosteriors(db, "m", [{ rule: "json_valid", pass: false }], "route-a");
  const row = await db.prepare("SELECT alpha, beta FROM taste_posteriors WHERE slug='m' AND rule='json_valid' AND route='route-a'").first();
  // The old 10 passes should be decayed toward 5 (half-life 30 days), plus 1 new failure.
  assert.ok(Number(row.alpha) < 11, "old evidence decayed: alpha=" + row.alpha);
  assert.ok(Number(row.alpha) >= 5.5, "decayed toward the prior, not past it: alpha=" + row.alpha);
  assert.ok(Number(row.beta) >= 2, "new failure added: beta=" + row.beta);
});

test("no decay when evidence is fresh", async () => {
  const db = createDb(":memory:");
  await ensureTasteSchema(db);
  await updatePosteriors(db, "m", [{ rule: "json_valid", pass: true }], "route-a");
  await updatePosteriors(db, "m", [{ rule: "json_valid", pass: true }], "route-a");
  const row = await db.prepare("SELECT alpha, beta FROM taste_posteriors WHERE slug='m' AND rule='json_valid' AND route='route-a'").first();
  assert.equal(Number(row.alpha), 3, "two passes plus prior 1");
  assert.equal(Number(row.beta), 1, "no failures plus prior 1");
});
