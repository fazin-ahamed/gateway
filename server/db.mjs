// Minimal D1-compatible SQLite wrapper for Node hosting (ecli.app VM).
// Translates the worker's `c.env.DB.prepare(sql).bind(...).first/all/run`
// surface onto node:sqlite. Only the shapes the gateway uses are supported.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function createDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  return {
    exec(sql) { db.exec(sql); },
    prepare(sql) {
      const stmt = db.prepare(sql);
      const api = {
        bind(...params) {
          api._params = params;
          return api;
        },
        first() {
          // node:sqlite get() handles SELECT and INSERT...RETURNING alike.
          return stmt.get(...(api._params || [])) ?? null;
        },
        all() {
          return { results: stmt.all(...(api._params || [])) };
        },
        run() {
          const info = stmt.run(...(api._params || []));
          return { meta: { changes: Number(info.changes || 0) } };
        },
      };
      return api;
    },
    batch(statements) {
      return statements.map(() => null);
    },
  };
}
