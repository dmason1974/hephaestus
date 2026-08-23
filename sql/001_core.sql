-- 001_core.sql — core tables shared by every Hephaestus unit.
--
-- Unit 1 (eco planner) is the first consumer, but Unit 1.5 (actual eco build),
-- Unit 2 (force projection) and Unit 3 (resource projection) all persist into
-- these same tables, discriminated by `run.unit`.
--
-- Every harness invocation inserts one `run` row and hangs its results off it,
-- so reruns accumulate as history rather than overwriting. This is what makes
-- one engine revision diffable against another.
--
-- NOTE: `schema_migration` is created by the migration runner (src/db/migrate.ts)
-- rather than here, because the runner must be able to query it before it can
-- decide whether to apply this file.

CREATE TABLE IF NOT EXISTS run (
  id           BIGSERIAL PRIMARY KEY,
  -- 'eco_plan' (Unit 1) | 'actual_eco' (1.5) | 'force_projection' (2) | 'resource_projection' (3)
  unit         TEXT        NOT NULL,
  scenario_id  TEXT        NOT NULL,
  -- NULL when the harness ran without a coalition plan (Unit 1 supports this).
  plan_id      TEXT,
  truce_days   INTEGER     NOT NULL,
  -- Free-form invocation parameters: beam width, topN, country filter, engine flags.
  params       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  git_commit   TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL while in flight; set on successful completion. A NULL here on an old
  -- row means the run died partway and its results are incomplete.
  finished_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS run_unit_scenario_idx
  ON run (unit, scenario_id, started_at DESC);

CREATE TABLE IF NOT EXISTS run_country (
  id           BIGSERIAL PRIMARY KEY,
  run_id       BIGINT  NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  country_id   TEXT    NOT NULL,
  country_name TEXT    NOT NULL,
  doctrine     TEXT    NOT NULL,
  -- 'homeland' | 'occupied'. Plan-specific, not a country-intrinsic fact.
  status       TEXT    NOT NULL,
  -- Only meaningful when status = 'occupied'.
  capture_day  INTEGER,
  UNIQUE (run_id, country_id)
);

CREATE TABLE IF NOT EXISTS run_city (
  id             BIGSERIAL PRIMARY KEY,
  run_country_id BIGINT  NOT NULL REFERENCES run_country(id) ON DELETE CASCADE,
  -- BARE city id (e.g. 'rome'), never the engine's prefixed '<country>:<city>' form.
  -- Unit 2's slots use bare ids, so storing bare here keeps later joins clean.
  city_id        TEXT    NOT NULL,
  city_name      TEXT    NOT NULL,
  resource       TEXT    NOT NULL,
  capital        BOOLEAN NOT NULL,
  UNIQUE (run_country_id, city_id)
);

-- The "Resource -> number map" shape that recurs throughout the engine, stored
-- with one column per resource (not EAV) so ranking/aggregation queries stay
-- direct: SUM(supplies + electronics) ORDER BY ... with no pivot.
--
-- scope_id points at run_city.id / run_country.id / eco_province_cohort.id
-- depending on scope_type, and is NULL for scope_type = 'run'.
--
-- IMPORTANT: 'country' rows are AGGREGATES of that country's 'city' and
-- 'province_cohort' rows. Never SUM across scope types in one query or you will
-- double-count.
CREATE TABLE IF NOT EXISTS resource_flow (
  id          BIGSERIAL PRIMARY KEY,
  run_id      BIGINT  NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  scope_type  TEXT    NOT NULL
    CHECK (scope_type IN ('run', 'country', 'city', 'province_cohort')),
  scope_id    BIGINT,
  -- Unit 1 writes 'production_total' and 'eco_build_cost'. Unit 3 will add
  -- 'eco_income', 'mob_cost', 'upkeep', 'net' against the same table.
  category    TEXT    NOT NULL,
  supplies    NUMERIC NOT NULL DEFAULT 0,
  components  NUMERIC NOT NULL DEFAULT 0,
  fuel        NUMERIC NOT NULL DEFAULT 0,
  rares       NUMERIC NOT NULL DEFAULT 0,
  electronics NUMERIC NOT NULL DEFAULT 0,
  cash        NUMERIC NOT NULL DEFAULT 0,
  manpower    NUMERIC NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS resource_flow_lookup_idx
  ON resource_flow (run_id, category, scope_type, scope_id);
