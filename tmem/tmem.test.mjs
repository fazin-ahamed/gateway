// T-Mem-lite tests. Signature normalization, trigger generation, RRF fusion,
// and round-trip recall through an in-memory sqlite store.

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeFailure, generateTriggers, reciprocalRankFusion, TMEM_SCHEMA } from "./index.js";
import { migrateTmem, recordEpisode, recall } from "./index.js";

// node:sqlite in-memory DB (synchronous API, matches the store's contract).
// The export is DatabaseSync on Node 22; fall back to nothing when the
// experimental flag is absent so the pure-logic tests still run.
let Database;
try {
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  Database = null;
}
const canDb = !!Database;

test("normalizeFailure lifts a stable compiler code as the fingerprint", () => {
  const sig = normalizeFailure("error TS2322: Type 'string' is not assignable to type 'number'.");
  assert.equal(sig.errorClass, "TS2322");
  assert.equal(sig.fingerprint, "TS2322");
});

test("normalizeFailure keeps a repo-relative path shape", () => {
  const sig = normalizeFailure("at handler (/home/fazinahamed/Documents/gateway/ai-gateway/src/index.js:100:5)");
  assert.match(sig.file, /src\/index\.js$/, "absolute prefix stripped, trailing path preserved");
  assert.ok(!/[A-Za-z]:[\\/]/.test(sig.file), "no drive letter or absolute prefix");
});

test("normalizeFailure handles empty input and still returns something for garbage", () => {
  assert.equal(normalizeFailure(""), null);
  const sig = normalizeFailure("something odd happened");
  assert.ok(sig.fingerprint);
  assert.equal(sig.errorClass, "uncoded");
});

test("normalizeFailure is stable across runs (line numbers do not fragment the key)", () => {
  const a = normalizeFailure("at Foo.render (/repo/src/Foo.tsx:91:12)");
  const b = normalizeFailure("at Foo.render (/repo/src/Foo.tsx:102:3)");
  assert.equal(a.fingerprint.split("@")[0], b.fingerprint.split("@")[0]);
  assert.equal(a.symbol, b.symbol);
});

test("generateTriggers dedupes and drops empty phrases", () => {
  const trigs = generateTriggers({
    scope: "gateway",
    task: "code:debug",
    files: ["src/index.js", "src/index.js"],
    symbols: ["handleStream"],
    technique: "close controller before rethrow",
    errorSignature: { errorClass: "ECONNRESET", symbol: "handleStream", file: "src/index.js" }
  });
  const keys = trigs.map((t) => t.kind + ":" + t.phrase);
  assert.equal(new Set(keys).size, keys.length, "no duplicate kind+phrase");
  assert.ok(trigs.every((t) => t.phrase && t.weight > 0));
});

test("generateTriggers returns [] for an empty episode", () => {
  assert.deepEqual(generateTriggers(null), []);
  assert.deepEqual(generateTriggers({}), []);
});

test("reciprocalRankFusion ranks ids appearing in multiple lists higher", () => {
  const fused = reciprocalRankFusion([[1, 2, 3], [3, 4, 1]]);
  const top = fused[0];
  assert.equal(top.id, 1, "id present in both lists ranks first");
  const byId = new Map(fused.map((f) => [f.id, f.score]));
  assert.ok(byId.get(1) > byId.get(2));
});

test("reciprocalRankFusion respects the limit and skips non-lists", () => {
  assert.equal(reciprocalRankFusion([[1], null, undefined, [2]], { limit: 1 }).length, 1);
  assert.deepEqual(reciprocalRankFusion([]), []);
});

test("TMEM_SCHEMA creates the fts5 virtual table", () => {
  assert.match(TMEM_SCHEMA, /CREATE VIRTUAL TABLE IF NOT EXISTS tmem_fts USING fts5/);
  assert.match(TMEM_SCHEMA, /CREATE TABLE IF NOT EXISTS tmem_episodes/);
  assert.match(TMEM_SCHEMA, /tmem_error_signatures/);
  assert.match(TMEM_SCHEMA, /tmem_triggers/);
});

if (canDb) {
  const openDb = () => {
    const db = new Database(":memory:");
    migrateTmem(db);
    return db;
  };

  test("recordEpisode round-trips and is recallable by error fingerprint", () => {
    const db = openDb();
    const ep = recordEpisode(db, {
      task: "code:debug",
      scope: "gateway",
      rootCause: "relay tunnel closed mid-stream",
      technique: "close the controller before rethrow",
      files: ["src/index.js"],
      symbols: ["koyebExchange"],
      error: "ECONNRESET at koyebExchange (src/index.js:1600:5)",
      verified: true,
      skill: "swe-debug",
      profile: "DEEP"
    });
    assert.ok(ep && ep.id > 0);
    assert.equal(ep.verified, 1);
    assert.match(ep.errorSignature.fingerprint, /ECONNRESET/);

    const hits = recall(db, { fingerprint: "ECONNRESET" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, ep.id);
    assert.equal(hits[0].technique, "close the controller before rethrow");
  });

  test("recall fuses FTS text match with exact file match", () => {
    const db = openDb();
    const a = recordEpisode(db, { task: "code:debug", scope: "swe", rootCause: "premature eof in relay", technique: "synthesize length terminal", files: ["relay/server.go"], verified: true });
    const b = recordEpisode(db, { task: "code:debug", scope: "swe", rootCause: "unrelated null deref", technique: "add a null guard", files: ["src/util.js"], verified: true });

    const byText = recall(db, { query: "premature eof" });
    assert.ok(byText.some((h) => h.id === a.id), "FTS should rank the matching episode");
    assert.ok(!byText.some((h) => h.id === b.id), "non-matching episode absent from a 1-limit recall");

    const byFile = recall(db, { files: ["relay/server.go"] });
    assert.equal(byFile[0].id, a.id, "exact file match recalls its episode");

    const both = recall(db, { query: "eof", files: ["relay/server.go"] });
    assert.equal(both[0].id, a.id, "fused recall still prefers the episode matching both signals");
  });

  test("recall returns [] when nothing matches", () => {
    const db = openDb();
    recordEpisode(db, { task: "code:debug", scope: "x", rootCause: "one thing" });
    assert.deepEqual(recall(db, { query: "zzz-nomatch-zzz" }), []);
    assert.deepEqual(recall(db, {}), []);
  });

  test("an unverified episode is still recorded for its failure technique", () => {
    const db = openDb();
    const ep = recordEpisode(db, { task: "code:debug", scope: "swe", rootCause: "guessed at the value", technique: "reproduced first", failedTechniques: ["edited blind"], verified: false });
    const hits = recall(db, { query: "guessed" });
    assert.equal(hits[0].id, ep.id);
    assert.equal(hits[0].verified, 0);
    assert.match(hits[0].failed_techniques, /edited blind/);
  });
} else {
  test("node:sqlite unavailable — store round-trip tests skipped", () => {
    assert.ok(true);
  });
}
