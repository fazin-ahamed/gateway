-- 0004: Optional taste layer posteriors, keyed per (slug, rule, route, account).
-- Route and account default to '' for pre-keyed data. Additive.
CREATE TABLE IF NOT EXISTS taste_posteriors (
  slug TEXT NOT NULL,
  rule TEXT NOT NULL,
  route TEXT NOT NULL DEFAULT '',
  account_id TEXT NOT NULL DEFAULT '',
  alpha REAL NOT NULL DEFAULT 1,
  beta REAL NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (slug, rule, route, account_id)
);
