-- 0004: Optional taste layer posteriors, keyed per (slug, rule, route).
-- Route defaults to '' for pre-route-keyed data. Additive.
CREATE TABLE IF NOT EXISTS taste_posteriors (
  slug TEXT NOT NULL,
  rule TEXT NOT NULL,
  route TEXT NOT NULL DEFAULT '',
  alpha REAL NOT NULL DEFAULT 1,
  beta REAL NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (slug, rule, route)
);
