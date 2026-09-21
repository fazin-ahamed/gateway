// T-Mem-lite — memory without embeddings.
//
// HORIZON-Omega: no embedding model on a 512MB server. Retrieval is SQLite
// FTS5 over structured episode text, exact identifiers, error fingerprints
// and file/symbol matches, ranked by reciprocal-rank fusion.
//
// Scope: this is the agent/repo-side store, NOT gateway serving state.
// Private project memories never belong in the gateway DB. The module owns
// its own sqlite file path; the gateway proper never opens it.

export const TMEM_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tmem_episodes (`,
  `  id INTEGER PRIMARY KEY AUTOINCREMENT,`,
  `  task TEXT NOT NULL,`,
  `  scope TEXT NOT NULL DEFAULT '',`,
  `  root_cause TEXT,`,
  `  technique TEXT,`,
  `  failed_techniques TEXT,`,
  `  verifier_result TEXT,`,
  `  skill TEXT,`,
  `  profile TEXT,`,
  `  verified INTEGER NOT NULL DEFAULT 0,`,
  `  created_at TEXT NOT NULL,`,
  `  updated_at TEXT NOT NULL`,
  `);`,
  ``,
  `CREATE TABLE IF NOT EXISTS tmem_files (`,
  `  episode_id INTEGER NOT NULL,`,
  `  path TEXT NOT NULL,`,
  `  PRIMARY KEY (episode_id, path),`,
  `  FOREIGN KEY (episode_id) REFERENCES tmem_episodes(id) ON DELETE CASCADE`,
  `);`,
  ``,
  `CREATE TABLE IF NOT EXISTS tmem_symbols (`,
  `  episode_id INTEGER NOT NULL,`,
  `  symbol TEXT NOT NULL,`,
  `  PRIMARY KEY (episode_id, symbol),`,
  `  FOREIGN KEY (episode_id) REFERENCES tmem_episodes(id) ON DELETE CASCADE`,
  `);`,
  ``,
  `CREATE TABLE IF NOT EXISTS tmem_error_signatures (`,
  `  episode_id INTEGER NOT NULL,`,
  `  fingerprint TEXT NOT NULL,`,
  `  error_class TEXT NOT NULL,`,
  `  symbol TEXT,`,
  `  file TEXT,`,
  `  PRIMARY KEY (episode_id, fingerprint),`,
  `  FOREIGN KEY (episode_id) REFERENCES tmem_episodes(id) ON DELETE CASCADE`,
  `);`,
  ``,
  `CREATE TABLE IF NOT EXISTS tmem_triggers (`,
  `  id INTEGER PRIMARY KEY AUTOINCREMENT,`,
  `  episode_id INTEGER NOT NULL,`,
  `  kind TEXT NOT NULL,`,
  `  phrase TEXT NOT NULL,`,
  `  weight REAL NOT NULL DEFAULT 1.0,`,
  `  UNIQUE (episode_id, kind, phrase),`,
  `  FOREIGN KEY (episode_id) REFERENCES tmem_episodes(id) ON DELETE CASCADE`,
  `);`,
  ``,
  `-- FTS5 over the fields a new task can be lexically matched against. The`,
  `-- contentless projection keeps the index small: we only need episode ids`,
  `-- back, never the bodies themselves.`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS tmem_fts USING fts5(`,
  `  task, scope, root_cause, technique, failed_techniques,`,
  `  content='', detail=none, tokenize='porter unicode61'`,
  `);`,
  ``,
  `CREATE INDEX IF NOT EXISTS tmem_episodes_scope ON tmem_episodes(scope);`,
  `CREATE INDEX IF NOT EXISTS tmem_triggers_kind ON tmem_triggers(kind);`
].join("\n");

// RRF (reciprocal rank fusion) over ranked id lists. Cheap, embedding-free,
// and the standard way to combine FTS + exact-identifier retrieval.
export function reciprocalRankFusion(rankedLists, { k = 60, limit = 10 } = {}) {
  const scores = new Map();
  for (const list of rankedLists) {
    if (!Array.isArray(list))
      continue;
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank];
      if (id == null)
        continue;
      const prev = scores.get(id) || 0;
      scores.set(id, prev + 1 / (k + rank + 1));
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]) => ({ id, score }));
}
