-- 004_force_overrun.sql — CountryForceProjectionResult.overrunDemands.
--
-- A mob step whose real, research-level-split mobEnd lands after the truce
-- deadline (see splitMobBatchByLevel/overrunDemands in
-- country-force-projection.ts). A country can have non-empty
-- force_city_slot/force_mob_step rows (it "looks" allocated) while still being
-- infeasible solely because of rows here — this table is what actually explains
-- why, distinct from the coarse force_country_result.reason ('no_demands' |
-- 'no_active_demands' only). Added in a separate migration rather than folded
-- into 003_force.sql because 003 was already applied to this shared DB before
-- this table existed — migrations are append-only, never edited after the fact.
--
-- city_id is stored bare (TEXT, not a run_city FK) — deliberately country-scoped
-- like force_research_segment/force_province_mob_result, since this is a
-- diagnostic list, not structured per-city detail requiring referential joins.
CREATE TABLE IF NOT EXISTS force_overrun_demand (
  id                   BIGSERIAL PRIMARY KEY,
  run_country_id       BIGINT  NOT NULL REFERENCES run_country(id) ON DELETE CASCADE,
  step_no              INTEGER NOT NULL,
  unit_id              TEXT    NOT NULL,
  city_id              TEXT    NOT NULL,
  level                INTEGER NOT NULL,
  mob_end_abs_hour     NUMERIC NOT NULL,
  deadline_abs_hour    NUMERIC NOT NULL,
  UNIQUE (run_country_id, step_no)
);

-- force_mob_step.level's original comment ("Set only for unit_limit-gated
-- tranches... NULL for ordinary mob steps") is now stale: mobilisation cost and
-- duration are priced by whichever research level is complete at the moment
-- each unit's own slot starts (see splitMobBatchByLevel), so a slow-draining
-- batch can straddle several research-level tiers — this applies to ordinary
-- units now too, not only unit_limit tranches, and `level` is populated for
-- every row.
COMMENT ON COLUMN force_mob_step.level IS
  'The research level this specific phase/tranche mobilises at.';
