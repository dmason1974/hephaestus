-- 003_force.sql — Unit 2 (force projection) results.
--
-- Persists computeCountryForceProjection's output (see
-- src/engine/optimization/country-force-projection.ts), run with eco credit from
-- Unit 1.5 (src/engine/optimization/eco-credited-force-projection.ts). Unit 1.5's
-- own per-city eco data is NOT duplicated into new tables here — it's the exact
-- same CityEcoResult shape Unit 1 already persists (see 002_eco.sql), so the
-- force-run repository reuses eco_city_result/eco_build_action/eco_step_delta for
-- every city in the country, and only these force_* tables are new. One run_city
-- row therefore carries both halves: eco build sequence, and (for cities with an
-- assigned demand) the post-flip military infra chain and mob queue.
--
-- Country-level aggregate costs go into resource_flow (001_core.sql) under
-- categories 'infra_ro', 'infra_buildings', 'mobilisation', 'upkeep',
-- 'province_mobilisation', 'province_upkeep', 'total' (scope_type = 'country'),
-- so they share the ranking/aggregation path with every other unit.

-- One row per run_country: the top-level projection outcome. 1:1 with
-- run_country, same relationship eco_city_result has with run_city.
CREATE TABLE IF NOT EXISTS force_country_result (
  run_country_id       BIGINT PRIMARY KEY
                          REFERENCES run_country(id) ON DELETE CASCADE,
  morale_at_start       NUMERIC NOT NULL,
  morale_at_deadline    NUMERIC NOT NULL,
  infeasible            BOOLEAN NOT NULL,
  -- 'no_demands' | 'no_active_demands', NULL when feasible.
  reason                TEXT,
  -- string[] of human-readable demand labels.
  demand_labels         JSONB   NOT NULL DEFAULT '[]'::jsonb,
  -- Demand[] — launcher-platform demands skipped (genuine zero mob cost).
  skipped_demands       JSONB   NOT NULL DEFAULT '[]'::jsonb,
  -- Demand[] — units with no mobilisation data for this country's doctrine at all.
  missing_data_demands  JSONB   NOT NULL DEFAULT '[]'::jsonb,
  -- PlanWeights (Partial<Record<Resource, number>>) actually used for this
  -- country's own city-assignment/RO-level decisions.
  plan_weights          JSONB   NOT NULL DEFAULT '{}'::jsonb
);

-- One row per run_city with an assigned demand (CityForceProjectionSlot). Cities
-- with no demand never get a row here — matches
-- CountryForceProjectionResult.citySlots only including assigned cities. Every
-- city (assigned or not) still has its own run_city + eco_city_result rows.
CREATE TABLE IF NOT EXISTS force_city_slot (
  run_city_id          BIGINT PRIMARY KEY
                          REFERENCES run_city(id) ON DELETE CASCADE,
  ro_level             INTEGER NOT NULL,
  primary_unit_id      TEXT    NOT NULL,
  infra_open_hour      NUMERIC NOT NULL,
  flip_point_abs_hour  NUMERIC NOT NULL,
  -- MobQueueEntry[] (unitId, count, totalMobHours, smithRatio, upkeepRateScalar,
  -- tPerUnit) — small structured list, no cross-city aggregation need.
  mob_queue            JSONB   NOT NULL DEFAULT '[]'::jsonb
);

-- ecoBackfillSteps ('eco_backfill') + infraSteps ('infra') — kept in their own
-- per-array order (step_no is an ordinal within `kind`, not a merged
-- chronological index; the two arrays are structurally disjoint by construction,
-- see CityForceProjectionSlot's own docstring). ORDER BY start_hour reconstructs
-- the chronological view when needed.
CREATE TABLE IF NOT EXISTS force_infra_step (
  id            BIGSERIAL PRIMARY KEY,
  run_city_id   BIGINT  NOT NULL REFERENCES run_city(id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL CHECK (kind IN ('eco_backfill', 'infra')),
  step_no       INTEGER NOT NULL,
  name          TEXT    NOT NULL,
  building_id   TEXT    NOT NULL,
  from_level    INTEGER NOT NULL,
  to_level      INTEGER NOT NULL,
  start_hour    NUMERIC NOT NULL,
  end_hour      NUMERIC NOT NULL,
  dur_h         NUMERIC NOT NULL,
  -- Per-step ResourceCost — same precedent as eco_step_delta (a step has no
  -- scope row of its own to point resource_flow at).
  supplies      NUMERIC NOT NULL DEFAULT 0,
  components    NUMERIC NOT NULL DEFAULT 0,
  fuel          NUMERIC NOT NULL DEFAULT 0,
  rares         NUMERIC NOT NULL DEFAULT 0,
  electronics   NUMERIC NOT NULL DEFAULT 0,
  cash          NUMERIC NOT NULL DEFAULT 0,
  manpower      NUMERIC NOT NULL DEFAULT 0,
  UNIQUE (run_city_id, kind, step_no)
);

CREATE INDEX IF NOT EXISTS force_infra_step_timeline_idx
  ON force_infra_step (run_city_id, start_hour);

-- mobSteps — no per-step cost field on the engine type (cost only exists at the
-- country-level costs.mobilisation bucket), so no resource columns here.
CREATE TABLE IF NOT EXISTS force_mob_step (
  id               BIGSERIAL PRIMARY KEY,
  run_city_id      BIGINT  NOT NULL REFERENCES run_city(id) ON DELETE CASCADE,
  step_no          INTEGER NOT NULL,
  unit_id          TEXT    NOT NULL,
  count            INTEGER NOT NULL,
  -- Set only for unit_limit-gated tranches (e.g. elite_attack_helicopter's
  -- 5/10/15 alive-cap) — the research level this batch mobilises at. NULL for
  -- ordinary (non-tranche) mob steps.
  level            INTEGER,
  start_abs_hour   NUMERIC NOT NULL,
  end_abs_hour     NUMERIC NOT NULL,
  duration_hours   NUMERIC NOT NULL,
  UNIQUE (run_city_id, step_no)
);

-- UnitResearchSegment[] — country-scoped (research slots aren't per-city), so
-- this hangs off run_country, not run_city.
CREATE TABLE IF NOT EXISTS force_research_segment (
  id                       BIGSERIAL PRIMARY KEY,
  run_country_id           BIGINT  NOT NULL REFERENCES run_country(id) ON DELETE CASCADE,
  step_no                  INTEGER NOT NULL,
  slot                     INTEGER NOT NULL,
  unit_id                  TEXT    NOT NULL,
  level                    INTEGER NOT NULL,
  unlock_day               INTEGER NOT NULL,
  start_abs_hour           NUMERIC NOT NULL,
  end_abs_hour_exclusive   NUMERIC NOT NULL,
  duration_hours           NUMERIC NOT NULL,
  supplies                 NUMERIC NOT NULL DEFAULT 0,
  components               NUMERIC NOT NULL DEFAULT 0,
  fuel                     NUMERIC NOT NULL DEFAULT 0,
  rares                    NUMERIC NOT NULL DEFAULT 0,
  electronics              NUMERIC NOT NULL DEFAULT 0,
  cash                     NUMERIC NOT NULL DEFAULT 0,
  manpower                 NUMERIC NOT NULL DEFAULT 0,
  UNIQUE (run_country_id, step_no)
);

-- ProvinceMobilizationPlan[] — country-scoped, one row per unitId.
CREATE TABLE IF NOT EXISTS force_province_mob_result (
  id                                        BIGSERIAL PRIMARY KEY,
  run_country_id                            BIGINT  NOT NULL REFERENCES run_country(id) ON DELETE CASCADE,
  step_no                                   INTEGER NOT NULL,
  unit_id                                   TEXT    NOT NULL,
  -- Highest tranche level actually mobilised at — see `tranches` for the full
  -- per-tranche breakdown.
  level                                     INTEGER NOT NULL,
  count                                     INTEGER NOT NULL,
  province_count                            INTEGER NOT NULL,
  mercenary_outpost_required_level          INTEGER NOT NULL,
  mercenary_outpost_build_hours             NUMERIC NOT NULL,
  mob_start_hour                            NUMERIC NOT NULL,
  completion_hour                           NUMERIC NOT NULL,
  mobilization_duration_hours               NUMERIC NOT NULL,
  -- ProvinceMobilizationTrancheResult[] — nested per-tranche detail, same call
  -- as eco_province_cohort.build_sequence.
  tranches                                  JSONB   NOT NULL DEFAULT '[]'::jsonb,
  mercenary_outpost_build_cost_supplies     NUMERIC NOT NULL DEFAULT 0,
  mercenary_outpost_build_cost_components   NUMERIC NOT NULL DEFAULT 0,
  mercenary_outpost_build_cost_fuel         NUMERIC NOT NULL DEFAULT 0,
  mercenary_outpost_build_cost_rares        NUMERIC NOT NULL DEFAULT 0,
  mercenary_outpost_build_cost_electronics  NUMERIC NOT NULL DEFAULT 0,
  mercenary_outpost_build_cost_cash         NUMERIC NOT NULL DEFAULT 0,
  mercenary_outpost_build_cost_manpower     NUMERIC NOT NULL DEFAULT 0,
  mobilization_cost_supplies                NUMERIC NOT NULL DEFAULT 0,
  mobilization_cost_components              NUMERIC NOT NULL DEFAULT 0,
  mobilization_cost_fuel                    NUMERIC NOT NULL DEFAULT 0,
  mobilization_cost_rares                   NUMERIC NOT NULL DEFAULT 0,
  mobilization_cost_electronics             NUMERIC NOT NULL DEFAULT 0,
  mobilization_cost_cash                    NUMERIC NOT NULL DEFAULT 0,
  mobilization_cost_manpower                NUMERIC NOT NULL DEFAULT 0,
  UNIQUE (run_country_id, step_no)
);
