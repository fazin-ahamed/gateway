// T-Mem-lite store: episode persistence + FTS retrieval.
//
// Agent-side only. The gateway serving path never imports this. Opened
// against a caller-supplied sqlite path (better-sqlite3-style sync API is
// the assumed shape; node:sqlite also matches).

import { TMEM_SCHEMA, reciprocalRankFusion } from "./schema.js";
import { normalizeFailure, generateTriggers } from "./signatures.js";

export function migrateTmem(db) {
  if (!db || typeof db.exec !== "function")
    throw new Error("tmem: db must expose exec()");
  db.exec(TMEM_SCHEMA);
  return true;
}

export function recordEpisode(db, ep) {
  if (!db || !ep)
    return null;
  const now = new Date().toISOString();
  const sig = ep.errorSignature || (ep.error ? normalizeFailure(ep.error) : null);
  const episode = {
    task: String(ep.task || ""),
    scope: String(ep.scope || ""),
    rootCause: String(ep.rootCause || ep.root_cause || ""),
    technique: String(ep.technique || ""),
    failedTechniques: Array.isArray(ep.failedTechniques) ? ep.failedTechniques.join("; ") : String(ep.failed_techniques || ""),
    verifierResult: String(ep.verifierResult || ep.verifier_result || (ep.verified ? "verified" : "unverified")),
    skill: String(ep.skill || ""),
    profile: String(ep.profile || ""),
    verified: ep.verified ? 1 : 0,
    createdAt: ep.createdAt || now,
    updatedAt: now
  };

  const ins = db.prepare(
    `INSERT INTO tmem_episodes (task, scope, root_cause, technique, failed_techniques, verifier_result, skill, profile, verified, created_at, updated_at)
     VALUES (@task, @scope, @rootCause, @technique, @failedTechniques, @verifierResult, @skill, @profile, @verified, @createdAt, @updatedAt)`
  );
  const info = ins.run(episode);
  const id = info && info.lastInsertRowid;
  if (id == null)
    return null;

  const files = Array.isArray(ep.files) ? ep.files : [];
  const symbols = Array.isArray(ep.symbols) ? ep.symbols : [];
  const insFile = db.prepare(`INSERT OR IGNORE INTO tmem_files (episode_id, path) VALUES (?, ?)`);
  for (const f of files)
    insFile.run(id, String(f));
  const insSym = db.prepare(`INSERT OR IGNORE INTO tmem_symbols (episode_id, symbol) VALUES (?, ?)`);
  for (const s of symbols)
    insSym.run(id, String(s));

  if (sig) {
    const insSig = db.prepare(
      `INSERT OR IGNORE INTO tmem_error_signatures (episode_id, fingerprint, error_class, symbol, file)
       VALUES (?, ?, ?, ?, ?)`
    );
    insSig.run(id, sig.fingerprint, sig.errorClass, sig.symbol || null, sig.file || null);
  }

  // Anticipatory triggers: a future task mentioning any phrase should recall
  // this episode. Generated from templates, no LLM.
  const triggers = generateTriggers({ ...ep, errorSignature: sig });
  const insTrig = db.prepare(
    `INSERT OR IGNORE INTO tmem_triggers (episode_id, kind, phrase, weight) VALUES (?, ?, ?, ?)`
  );
  for (const t of triggers)
    insTrig.run(id, t.kind, t.phrase, t.weight);

  // FTS index row. Contentless table: we only match, we never read back.
  const insFts = db.prepare(
    `INSERT INTO tmem_fts (rowid, task, scope, root_cause, technique, failed_techniques)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  insFts.run(id, episode.task, episode.scope, episode.rootCause, episode.technique, episode.failedTechniques);

  return { id, ...episode, files, symbols, errorSignature: sig, triggers };
}

// Exact-identifier recall: episodes touching a file or symbol, or carrying
// a matching error fingerprint. Ranked by weight then recency.
export function recallByIdentifiers(db, { files = [], symbols = [], fingerprint = null, scope = null, limit = 20 } = {}) {
  if (!db)
    return [];
  const out = [];
  const seen = new Set();
  const push = (rows) => {
    for (const r of rows || []) {
      if (r && !seen.has(r.episode_id)) {
        seen.add(r.episode_id);
        out.push({ id: r.episode_id, score: Number(r.w || 1) });
      }
    }
  };
  const q = (sql, params) => {
    try {
      return db.prepare(sql).all(...params);
    } catch {
      return [];
    }
  };
  for (const f of files)
    push(q(`SELECT episode_id, 0.9 w FROM tmem_files WHERE path = ?`, [String(f)]));
  for (const s of symbols)
    push(q(`SELECT episode_id, 0.85 w FROM tmem_symbols WHERE symbol = ?`, [String(s)]));
  if (fingerprint)
    push(q(`SELECT episode_id, 1.0 w FROM tmem_error_signatures WHERE fingerprint = ? OR error_class = ?`, [String(fingerprint), String(fingerprint)]));
  if (scope)
    push(q(`SELECT id episode_id, 0.6 w FROM tmem_episodes WHERE scope = ?`, [String(scope)]));
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// Lexical recall over the FTS index.
export function recallByFts(db, query, limit = 20) {
  if (!db || !query)
    return [];
  try {
    const rows = db.prepare(
      `SELECT rowid AS id, bm25(tmem_fts) AS rank FROM tmem_fts WHERE tmem_fts MATCH ? ORDER BY rank LIMIT ?`
    ).all(String(query), limit);
    return rows.map((r, i) => ({ id: r.id, score: -Number(r.rank || 0), rank: i }));
  } catch {
    return [];
  }
}

// Combined retrieval: FTS + exact identifiers, fused by reciprocal rank.
export function recall(db, { query = "", files = [], symbols = [], fingerprint = null, scope = null, limit = 10 } = {}) {
  const fts = recallByFts(db, query, 20).map((r) => r.id);
  const ident = recallByIdentifiers(db, { files, symbols, fingerprint, scope, limit: 20 }).map((r) => r.id);
  const fused = reciprocalRankFusion([fts, ident], { limit });
  if (!fused.length)
    return [];
  const ids = fused.map((f) => f.id);
  const placeholders = ids.map(() => "?").join(",");
  try {
    const rows = db.prepare(
      `SELECT e.id, e.task, e.scope, e.root_cause, e.technique, e.failed_techniques, e.verifier_result, e.skill, e.profile, e.verified, e.updated_at
       FROM tmem_episodes e WHERE e.id IN (${placeholders})`
    ).all(...ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return fused
      .map((f) => (byId.has(f.id) ? { ...byId.get(f.id), score: f.score } : null))
      .filter(Boolean);
  } catch {
    return [];
  }
}

export { normalizeFailure, generateTriggers, reciprocalRankFusion };
