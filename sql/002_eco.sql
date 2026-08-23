-- 002_eco.sql — Unit 1 (eco planner) and Unit 1.5 (actual eco build) results.
--
-- Per-city and per-cohort totals are NOT stored here; they go into
-- resource_flow (see 001_core.sql) under categories 'production_total' and
-- 'eco_build_cost', so they share the ranking/aggregation path with every
-- other unit.

CREATE TABLE IF NOT EXISTS eco_city_result (
  run_city_id                    BIGINT PRIMARY KEY
                                   REFERENCES run_city(id) ON DELETE CASCADE,
  -- Building levels the city starts the scenario with (from country YAML).
  starting_levels                JSONB   NOT NULL DEFAULT '{}'::jsonb,
  -- Absolute game hour at which the last eco build completes. NUMERIC, not
  -- INTEGER: build durations are morale-adjusted and computed in minutes, so
  -- every hour value in the engine is fractional (build-order-timeline.ts
  -- derives startRelHour as (minutes / 60)).
  last_build_completion_abs_hour NUMERIC,
  -- Number of beam sequences explored for this city.
  explored                       INTEGER NOT NULL DEFAULT 0,
  -- hourlyCityProduction: array of {resource: number}, index 0 = scenario hour 0.
  -- Held as JSONB rather than ~4.7k rows per city; full fidelity, no rounding.
  hourly_production              JSONB   NOT NULL DEFAULT '[]'::jsonb
);

-- The winning build sequence (bestActions), in order.
CREATE TABLE IF NOT EXISTS eco_build_action (
  id             BIGSERIAL PRIMARY KEY,
  run_city_id    BIGINT  NOT NULL REFERENCES run_city(id) ON DELETE CASCADE,
  step_no        INTEGER NOT NULL,
  building_id    TEXT    NOT NULL,
  target_level   INTEGER NOT NULL,
  start_rel_hour NUMERIC,
  start_abs_hour NUMERIC,
  UNIQUE (run_city_id, step_no)
);

-- Marginal per-resource impact of each step vs. the previous step's ending
-- balances. Resource columns are inline rather than in resource_flow because a
-- step has no scope row of its own to point at.
CREATE TABLE IF NOT EXISTS eco_step_delta (
  id           BIGSERIAL PRIMARY KEY,
  run_city_id  BIGINT  NOT NULL REFERENCES run_city(id) ON DELETE CASCADE,
  step_no      INTEGER NOT NULL,
  building_id  TEXT    NOT NULL,
  target_level INTEGER NOT NULL,
  start_hour   NUMERIC NOT NULL,
  supplies     NUMERIC NOT NULL DEFAULT 0,
  components   NUMERIC NOT NULL DEFAULT 0,
  fuel         NUMERIC NOT NULL DEFAULT 0,
  rares        NUMERIC NOT NULL DEFAULT 0,
  electronics  NUMERIC NOT NULL DEFAULT 0,
  cash         NUMERIC NOT NULL DEFAULT 0,
  manpower     NUMERIC NOT NULL DEFAULT 0,
  UNIQUE (run_city_id, step_no)
);

-- Province cohorts are grouped by resource type, not modelled individually.
-- `resource` is NULL for the non-resource-producing cohort.
CREATE TABLE IF NOT EXISTS eco_province_cohort (
  id                BIGSERIAL PRIMARY KEY,
  run_country_id    BIGINT  NOT NULL REFERENCES run_country(id) ON DELETE CASCADE,
  cohort_id         TEXT    NOT NULL,
  resource          TEXT,
  province_count    INTEGER NOT NULL,
  build_sequence    JSONB   NOT NULL DEFAULT '[]'::jsonb,
  hourly_production JSONB   NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (run_country_id, cohort_id)
);
