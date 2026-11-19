-- 0002: Canonical model registry seed. Mirrors SEED_CANONICAL_MODELS and
-- SEED_MODEL_ALIASES from src/router/model-registry.js so the Worker never
-- needs the per-request ensureRegistrySeed write path (deployed schema is
-- pre-seeded; INSERT OR IGNORE keeps operator-authored rows authoritative).
-- Re-running is a no-op. The canonical rows carry NATIVE model capability;
-- route-specific transport ceilings clamp below via their own overrides.

INSERT OR IGNORE INTO canonical_models
  (id, family, display_name, reasoning, tools, vision, context_limit, output_limit, created_at, updated_at)
VALUES
  ('glm-5.3-flash', 'glm', 'GLM-5.3 Flash', 1, 1, 1, 98304, 16384, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('glm-5.3',       'glm', 'GLM-5.3',       1, 1, 0, 1000000, 131072, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('glm-5.2',       'glm', 'GLM-5.2',       1, 1, 0, 98304, 16384, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

-- Raise a canonical row only if it is still below the verified native seed
-- (operator values above the seed are never lowered; mirrors seedModelRegistry).
UPDATE canonical_models
SET context_limit = CASE WHEN context_limit IS NULL OR context_limit < 98304 THEN 98304 ELSE context_limit END,
    output_limit  = CASE WHEN output_limit  IS NULL OR output_limit  < 16384 THEN 16384 ELSE output_limit END,
    updated_at = '2026-01-01T00:00:00.000Z'
WHERE id = 'glm-5.3-flash'
  AND (context_limit IS NULL OR context_limit < 98304 OR output_limit IS NULL OR output_limit < 16384);

UPDATE canonical_models
SET context_limit = CASE WHEN context_limit IS NULL OR context_limit < 1000000 THEN 1000000 ELSE context_limit END,
    output_limit  = CASE WHEN output_limit  IS NULL OR output_limit  < 131072 THEN 131072 ELSE output_limit END,
    updated_at = '2026-01-01T00:00:00.000Z'
WHERE id = 'glm-5.3'
  AND (context_limit IS NULL OR context_limit < 1000000 OR output_limit IS NULL OR output_limit < 131072);

UPDATE canonical_models
SET context_limit = CASE WHEN context_limit IS NULL OR context_limit < 98304 THEN 98304 ELSE context_limit END,
    output_limit  = CASE WHEN output_limit  IS NULL OR output_limit  < 16384 THEN 16384 ELSE output_limit END,
    updated_at = '2026-01-01T00:00:00.000Z'
WHERE id = 'glm-5.2'
  AND (context_limit IS NULL OR context_limit < 98304 OR output_limit IS NULL OR output_limit < 16384);

INSERT OR IGNORE INTO model_aliases
  (alias, canonical_model_id, alias_type, provider_id, confidence, source, created_at)
VALUES
  ('glm-5.3-flash',      'glm-5.3-flash', 'public_slug',   NULL, 1.0, 'seed',             '2026-01-01T00:00:00.000Z'),
  ('z-ai/glm-5.3-flash', 'glm-5.3-flash', 'public_slug',   NULL, 1.0, 'seed',             '2026-01-01T00:00:00.000Z'),
  ('x-preview-l',        'glm-5.3-flash', 'wire_model',    NULL, 1.0, 'seed:registry',      '2026-01-01T00:00:00.000Z'),
  ('GLM-5.3-Flash',      'glm-5.3-flash', 'provider_alias', NULL, 1.0, 'seed:registry',  '2026-01-01T00:00:00.000Z'),
  ('glm-5-3-flash',      'glm-5.3-flash', 'legacy_alias',  NULL, 1.0, 'seed:registry',  '2026-01-01T00:00:00.000Z'),
  ('glm-5.3',            'glm-5.3',       'public_slug',   NULL, 1.0, 'seed',             '2026-01-01T00:00:00.000Z'),
  ('z-ai/glm-5.3',       'glm-5.3',       'public_slug',   NULL, 1.0, 'seed',             '2026-01-01T00:00:00.000Z'),
  ('GLM-5.3',            'glm-5.3',       'provider_alias', NULL, 1.0, 'seed:registry',  '2026-01-01T00:00:00.000Z'),
  ('glm-5.2',            'glm-5.2',       'public_slug',   NULL, 1.0, 'seed',             '2026-01-01T00:00:00.000Z'),
  ('z-ai/glm-5.2',       'glm-5.2',       'public_slug',   NULL, 1.0, 'seed',             '2026-01-01T00:00:00.000Z');
