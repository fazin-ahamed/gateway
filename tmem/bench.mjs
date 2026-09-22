// T-Mem-lite offline retrieval benchmark.
//
// A deterministic corpus, a ground-truth query set derived from that corpus,
// and retrieval-quality metrics over the real store. No embeddings, no network,
// no ai-gateway import — this exercises tmem/ only.
//
// Ground truth is by construction, not by hand-maintained id lists:
//   * a fingerprint query's relevant set is every episode whose raw error
//     normalizes to that fingerprint (the same normalizeFailure the store uses);
//   * a file, symbol, or scope query's relevant set is every episode carrying it;
//   * a lexical query's relevant set is every episode whose indexed text contains
//     the token. The tokens are porter-invariant and unique, so the set has size 1.
//
// The exact channels (fingerprint, file, symbol, scope, lexical) are perfect by
// construction: the queried channel is the only one that fires, so a relevant
// episode must rank first. The combined channel is the one that can regress.
// Its FTS list is ordered by rowid because tmem_fts is contentless — term
// frequency cannot move a row — so the distractor is inserted first and leads
// FTS. The target is the only episode that ALSO carries the file, so reciprocal
// rank fusion must promote it past the distractor to rank 1. That is the uplift.
//
// Every threshold below is exactly that construction guarantee. A miss is a
// retrieval regression, not corpus noise, so the process exits non-zero.
//
// Run: npm run bench   (node --experimental-sqlite bench.mjs)

import { DatabaseSync } from "node:sqlite";
import { migrateTmem, recordEpisode, recall, recallByFts, normalizeFailure } from "./index.js";

const reps = (word, n) => Array(n).fill(word).join(" ");

const TS2322 = "error TS2322: Type 'string' is not assignable to type 'number'.";
const ECONN = "read ECONNRESET";
const BUSY = "SQLITE_BUSY: database is locked";
const HTTP503 = "upstream returned HTTP 503";
const TYPEE = "TypeError: Cannot read properties of undefined (reading 'x')";
const ENOENT = "ENOENT: no such file or directory";
const EACCES = "EACCES: permission denied, open";
const CONSTRAINT = "SQLITE_CONSTRAINT: UNIQUE constraint failed";
const REF = "ReferenceError: chart is not defined";
const TS2345F = "error TS2345: Argument of type 'string' is not assignable.\n    at planHorizon (src/horizon.js:80:5)";
const TYPEF = "TypeError: value.x is not a function\n    at aggregateQuality (src/export/vey-world.js:40:3)";
const HTTP502F = "upstream returned HTTP 502\n    at proxyUpstream (src/router/policies.js:10:2)";

// key, scope, file, symbol, raw error (null = verified success, no signature), task.
const ep = (key, scope, file, symbol, error, task) => ({ key, scope, file, symbol, error, task });

const CORPUS = [
  ep("ts2322a", "router", "src/router/policies.js", "planHorizon", TS2322, "narrow the route score type"),
  ep("ts2322b", "export", "src/export/vey-world.js", "exportVeyEpisode", TS2322, "fix vey episode typing"),
  ep("ts2322c", "playground", "src/playground.js", "renderPanel", TS2322, "fix panel prop typing"),
  ep("econa", "router", "src/router/policies.js", "scoreRoute", ECONN, "handle upstream reset in scoring"),
  ep("econb", "tmem", "tmem/store.js", "recordEpisode", ECONN, "retry store write after reset"),
  ep("busya", "tmem", "tmem/store.js", "recall", BUSY, "yield on busy database reads"),
  ep("busyb", "skills", "skills/loader.js", "loadSkill", BUSY, "yield on busy skill load"),
  ep("http503a", "export", "src/export/vey-serve.js", "exportVeyDataset", HTTP503, "vey export upstream unavailable"),
  ep("http503b", "router", "src/router/quality.js", "weighSignal", HTTP503, "quality probe upstream unavailable"),
  ep("typea", "playground", "src/playground.js", "bindTab", TYPEE, "guard undefined tab binding"),
  ep("typeb", "skills", "skills/runner.js", "runSkill", TYPEE, "guard undefined skill result"),
  ep("enoent", "skills", "skills/runner.js", "readSkill", ENOENT, "missing skill file on disk"),
  ep("eacces", "tmem", "tmem/store.js", "openStore", EACCES, "store file permission denied"),
  ep("constraint", "router", "schema.sql", "migrate", CONSTRAINT, "duplicate route row rejected"),
  ep("referr", "playground", "src/playground.js", "drawChart", REF, "chart helper not defined"),
  ep("ts2345f", "router", "src/horizon.js", "planHorizon", TS2345F, "fix horizon argument type"),
  ep("backoffHigh", "export", "src/zzz/high.js", null, null, reps("backoff", 12)),
  ep("backoffMid", "tmem", "src/zzz/mid.js", null, null, reps("backoff", 3)),
  ep("backoffTarget", "router", "src/router/policies.js", "applyBackoff", null, "backoff in router"),
  ep("jitterHigh", "router", "src/zzz/jhigh.js", null, null, reps("jitter", 12)),
  ep("jitterMid", "skills", "src/zzz/jmid.js", null, null, reps("jitter", 3)),
  ep("jitterTarget", "export", "src/export/vey-serve.js", "scheduleExport", null, "jitter in export"),
  ep("lexQuat", "router", "src/router/quality.js", "quat", null, "fix quaternion normalization drift"),
  ep("lexMang", "tmem", "tmem/store.js", "mang", null, "prune mangrove index growth"),
  ep("lexTung", "export", "src/export/vey-world.js", "tung", null, "tungsten weight calibration"),
  ep("lexObsi", "playground", "src/playground.js", "obsi", null, "obsidian theme contrast fix"),
  ep("lexVana", "skills", "skills/loader.js", "vand", null, "vanadium cache invalidation"),
  ep("lexZeol", "router", "src/horizon.js", "zeol", null, "zeolite token bucket refill"),
  ep("http502f", "router", "src/router/policies.js", "proxyUpstream", HTTP502F, "handle bad gateway from upstream")
];

const FILE_QUERIES = ["src/router/policies.js", "tmem/store.js", "src/export/vey-world.js", "src/playground.js", "src/export/vey-serve.js"];
const SYMBOL_QUERIES = ["planHorizon", "recordEpisode", "exportVeyEpisode"];
const SCOPE_QUERIES = ["router", "tmem", "export", "playground", "skills"];
const LEXICAL_TOKENS = ["quaternion", "mangrove", "tungsten", "obsidian", "vanadium", "zeolite"];

// The distractor is seeded before the target, so it leads the contentless FTS
// list. The target is the only episode that also carries the file, so fusion
// must promote it past the distractor.
const COMBINED = [
  { token: "backoff", file: "src/router/policies.js", target: "backoffTarget", leader: "backoffHigh" },
  { token: "jitter", file: "src/export/vey-serve.js", target: "jitterTarget", leader: "jitterHigh" }
];

const CLASSES = ["fingerprint", "file", "symbol", "scope", "lexical", "combined"];

function indexedTokens(e) {
  return new Set(
    [e.task, e.scope].join(" ").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  );
}

function fingerprintOf(e) {
  if (!e.error)
    return null;
  const sig = normalizeFailure(e.error);
  return sig ? sig.fingerprint : null;
}

function seed(db) {
  migrateTmem(db);
  const idByKey = new Map();
  for (const e of CORPUS) {
    const row = recordEpisode(db, {
      task: e.task,
      scope: e.scope,
      files: e.file ? [e.file] : [],
      symbols: e.symbol ? [e.symbol] : [],
      error: e.error || undefined,
      verified: e.error ? 0 : 1,
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    if (!row || row.id == null)
      throw new Error("seed failed for " + e.key);
    idByKey.set(e.key, row.id);
  }
  return idByKey;
}

function buildQueries(idByKey) {
  const id = (key) => idByKey.get(key);
  const queries = [];

  const byFingerprint = new Map();
  for (const e of CORPUS) {
    const fp = fingerprintOf(e);
    if (!fp)
      continue;
    if (!byFingerprint.has(fp))
      byFingerprint.set(fp, []);
    byFingerprint.get(fp).push(id(e.key));
  }
  for (const [fp, ids] of byFingerprint)
    queries.push({ cls: "fingerprint", name: "fp:" + fp, args: { fingerprint: fp }, relevant: new Set(ids) });

  for (const file of FILE_QUERIES) {
    const ids = CORPUS.filter((e) => e.file === file).map((e) => id(e.key));
    queries.push({ cls: "file", name: "file:" + file, args: { files: [file] }, relevant: new Set(ids) });
  }
  for (const symbol of SYMBOL_QUERIES) {
    const ids = CORPUS.filter((e) => e.symbol === symbol).map((e) => id(e.key));
    queries.push({ cls: "symbol", name: "sym:" + symbol, args: { symbols: [symbol] }, relevant: new Set(ids) });
  }
  for (const scope of SCOPE_QUERIES) {
    const ids = CORPUS.filter((e) => e.scope === scope).map((e) => id(e.key));
    queries.push({ cls: "scope", name: "scope:" + scope, args: { scope }, relevant: new Set(ids) });
  }
  for (const token of LEXICAL_TOKENS) {
    const ids = CORPUS.filter((e) => indexedTokens(e).has(token)).map((e) => id(e.key));
    queries.push({ cls: "lexical", name: "lex:" + token, args: { query: token }, relevant: new Set(ids) });
  }
  for (const c of COMBINED) {
    const ids = CORPUS
      .filter((e) => indexedTokens(e).has(c.token) && e.file === c.file)
      .map((e) => id(e.key));
    queries.push({
      cls: "combined", name: "fuse:" + c.token, args: { query: c.token, files: [c.file] },
      relevant: new Set(ids), target: id(c.target), leader: id(c.leader), token: c.token
    });
  }
  return queries;
}

function firstRelevant(ids, relevant) {
  const at = ids.findIndex((x) => relevant.has(x));
  return at === -1 ? Infinity : at + 1;
}

function idsOf(db, args) {
  return recall(db, { ...args, limit: 10 }).map((r) => r.id);
}

function ftsIds(db, token) {
  return recallByFts(db, token, 20).map((r) => r.id);
}

function evaluate(db, queries) {
  const failures = [];
  const ranks = new Map();

  for (const q of queries) {
    if (q.relevant.size === 0)
      failures.push(q.name + ": relevant set is empty (corpus no longer satisfies the query)");
    if (q.cls === "lexical" && q.relevant.size !== 1)
      failures.push(q.name + ": lexical token must match exactly one episode, matched " + q.relevant.size);
    if (q.cls === "combined" && (q.relevant.size !== 1 || !q.relevant.has(q.target)))
      failures.push(q.name + ": target must be the only episode carrying both the token and the file");

    const ids = idsOf(db, q.args);
    const rank = firstRelevant(ids, q.relevant);
    ranks.set(q.name, rank);
    if (rank !== 1)
      failures.push(q.name + ": first relevant rank " + (rank === Infinity ? "absent" : rank) + ", expected 1");

    if (q.cls === "combined") {
      const fts = ftsIds(db, q.token);
      const leaderAt = fts.indexOf(q.leader);
      const targetAt = fts.indexOf(q.target);
      if (leaderAt === -1 || targetAt === -1)
        failures.push(q.name + ": FTS missed the distractor or the target");
      else if (!(leaderAt < targetAt))
        failures.push(q.name + ": the distractor no longer leads FTS (distractor " + leaderAt + ", target " + targetAt + "); the uplift precondition is gone");
      else if (targetAt === 0)
        failures.push(q.name + ": the target already leads FTS, so fusion is not what promotes it");
    }
  }

  return { failures, ranks };
}

function degenerate(db) {
  const failures = [];
  const check = (label, fn) => {
    let threw = false;
    let result;
    try {
      result = fn();
    } catch (e) {
      threw = true;
      failures.push(label + " threw: " + e.message);
    }
    if (!threw && !(Array.isArray(result) && result.length === 0))
      failures.push(label + " expected [], got " + JSON.stringify(result));
  };
  check("empty fingerprint", () => recall(db, { fingerprint: "ZZZNOMATCH" }));
  check("empty file", () => recall(db, { files: ["no/such.js"] }));
  check("empty scope", () => recall(db, { scope: "noscope" }));
  check("malformed fts", () => recallByFts(db, "\""));
  check("malformed fused", () => recall(db, { query: "\"" }));
  return failures;
}

function emptyDb() {
  const failures = [];
  const db = new DatabaseSync(":memory:");
  migrateTmem(db);
  for (const [label, fn] of [
    ["empty db recall", () => recall(db, { query: "anything", files: ["x"], fingerprint: "Y" })],
    ["empty db fts", () => recallByFts(db, "anything")],
    ["empty db malformed", () => recallByFts(db, "\"")]
  ]) {
    let threw = false;
    let result;
    try {
      result = fn();
    } catch (e) {
      threw = true;
      failures.push(label + " threw: " + e.message);
    }
    if (!threw && !(Array.isArray(result) && result.length === 0))
      failures.push(label + " expected [], got " + JSON.stringify(result));
  }
  db.close();
  return failures;
}

function snapshot(db, queries) {
  return JSON.stringify(queries.map((q) => ({ name: q.name, ids: idsOf(db, q.args), fts: q.token ? ftsIds(db, q.token) : null })));
}

function table(queries, ranks) {
  const line = (cls, n, h1, h3, h5, mrr) =>
    cls.padEnd(14) + String(n).padStart(4) +
    h1.padStart(8) + h3.padStart(8) + h5.padStart(8) + mrr.padStart(8);
  const out = [line("class", "n", "hit@1", "hit@3", "hit@5", "MRR")];
  let tn = 0;
  let t1 = 0;
  let t3 = 0;
  let t5 = 0;
  let tMrr = 0;
  for (const cls of CLASSES) {
    const rows = queries.filter((q) => q.cls === cls);
    const n = rows.length;
    const rs = rows.map((q) => ranks.get(q.name));
    const h = (k) => rs.filter((r) => r <= k).length;
    const mrr = n ? rs.reduce((s, r) => s + (r === Infinity ? 0 : 1 / r), 0) / n : 0;
    out.push(line(cls, n, (h(1) / n).toFixed(3), (h(3) / n).toFixed(3), (h(5) / n).toFixed(3), mrr.toFixed(3)));
    tn += n;
    t1 += h(1);
    t3 += h(3);
    t5 += h(5);
    tMrr += mrr * n;
  }
  out.push(line("aggregate", tn, (t1 / tn).toFixed(3), (t3 / tn).toFixed(3), (t5 / tn).toFixed(3), (tMrr / tn).toFixed(3)));
  return out.join("\n");
}

function main() {
  const db1 = new DatabaseSync(":memory:");
  const idByKey = seed(db1);
  const queries = buildQueries(idByKey);
  const { failures, ranks } = evaluate(db1, queries);
  failures.push(...degenerate(db1));

  const db2 = new DatabaseSync(":memory:");
  seed(db2);
  if (snapshot(db1, queries) !== snapshot(db2, queries))
    failures.push("determinism: two fresh databases produced different rankings");

  failures.push(...emptyDb());

  console.log(table(queries, ranks));
  if (failures.length) {
    console.log("BENCH FAIL");
    for (const f of failures)
      console.log("  " + f);
    process.exitCode = 1;
  } else {
    console.log("BENCH PASS");
  }
  db1.close();
  db2.close();
}

main();
