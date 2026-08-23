import type { PoolClient } from "pg";

import type { Resource } from "../core/constants.js";
import type { CityEcoResult, CountryEcoBeamResult } from "../engine/eco/city-eco-beam.js";
import type { ProvinceEcoBeamResult } from "../engine/eco/province-eco-beam.js";
import type { BuildAction } from "../engine/orchestration/build-order-timeline.js";
import { pool } from "./pool.js";

/** Column order for every resource-bearing table. Must match `Resource`. */
const RESOURCE_COLUMNS: Resource[] = [
  "supplies",
  "components",
  "fuel",
  "rares",
  "electronics",
  "cash",
  "manpower",
];

export type ResourceAmounts = Partial<Record<Resource, number>>;

/** resource_flow.scope_type */
export type ResourceScope = "run" | "country" | "city" | "province_cohort";

export type StartRunInput = {
  /** 'eco_plan' for Unit 1. See run.unit in sql/001_core.sql. */
  unit: string;
  scenarioId: string;
  planId?: string;
  truceDays: number;
  params: Record<string, unknown>;
  gitCommit?: string;
};

export type CountryEcoWriteInput = {
  runId: number;
  countryId: string;
  countryName: string;
  doctrine: string;
  status: "homeland" | "occupied";
  captureDay?: number;
  ecoResult: CountryEcoBeamResult;
  provinceResults: ProvinceEcoBeamResult[];
};

/**
 * The engine keys city results as `${countryId}:${cityId}`; Unit 2's slots use
 * the bare id. We store bare so later units join cleanly — this is the
 * documented join-key trap, made explicit in one place.
 */
export function bareCityId(prefixedOrBare: string): string {
  const idx = prefixedOrBare.indexOf(":");
  return idx === -1 ? prefixedOrBare : prefixedOrBare.slice(idx + 1);
}

function resourceValues(amounts: ResourceAmounts): number[] {
  return RESOURCE_COLUMNS.map(r => amounts[r] ?? 0);
}

function zeroResources(): Record<Resource, number> {
  return { supplies: 0, components: 0, fuel: 0, rares: 0, electronics: 0, cash: 0, manpower: 0 };
}

/** Sums an hourly production series into a single per-resource total. */
export function sumHourly(hourly: Array<Record<Resource, number>>): Record<Resource, number> {
  const total = zeroResources();
  for (const hour of hourly) {
    for (const r of RESOURCE_COLUMNS) total[r] += hour[r] ?? 0;
  }
  return total;
}

function addInto(target: Record<Resource, number>, source: ResourceAmounts): void {
  for (const r of RESOURCE_COLUMNS) target[r] += source[r] ?? 0;
}

/**
 * BuildAction carries two aliased relative-hour fields; the timeline resolves
 * them as `startRelHour ?? startHour`. Mirror that precedence exactly, and
 * derive the absolute hour once here so consumers never have to.
 */
export function actionHours(
  action: BuildAction,
  scenarioAbsHour: number
): { rel: number | null; abs: number | null } {
  const rel = action.startRelHour ?? action.startHour ?? null;
  return { rel, abs: rel === null ? null : rel + scenarioAbsHour };
}

async function insertResourceFlow(
  client: PoolClient,
  runId: number,
  scopeType: ResourceScope,
  scopeId: number | null,
  category: string,
  amounts: ResourceAmounts
): Promise<void> {
  await client.query(
    `INSERT INTO resource_flow
       (run_id, scope_type, scope_id, category, ${RESOURCE_COLUMNS.join(", ")})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [runId, scopeType, scopeId, category, ...resourceValues(amounts)]
  );
}

/** Opens a run and returns its id. Results are written against it as they complete. */
export async function startRun(input: StartRunInput): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO run (unit, scenario_id, plan_id, truce_days, params, git_commit)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      input.unit,
      input.scenarioId,
      input.planId ?? null,
      input.truceDays,
      JSON.stringify(input.params),
      input.gitCommit ?? null,
    ]
  );
  return Number(rows[0].id);
}

/**
 * Stamps finished_at. A run left with finished_at NULL died part-way and its
 * results should be treated as incomplete.
 */
export async function finishRun(runId: number): Promise<void> {
  await pool.query("UPDATE run SET finished_at = now() WHERE id = $1", [runId]);
}

/**
 * Persists one country's full eco result — country, cities, per-city beam
 * output, province cohorts, and the resource_flow totals — in a single
 * transaction, so a country is either wholly present or wholly absent.
 */
export async function writeCountryEcoResult(input: CountryEcoWriteInput): Promise<void> {
  const { runId, ecoResult, provinceResults } = input;
  const scenarioAbsHour = ecoResult.scenarioAbsHour;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: countryRows } = await client.query<{ id: string }>(
      `INSERT INTO run_country (run_id, country_id, country_name, doctrine, status, capture_day)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        runId,
        input.countryId,
        input.countryName,
        input.doctrine,
        input.status,
        input.captureDay ?? null,
      ]
    );
    const runCountryId = Number(countryRows[0].id);

    // Country-level aggregate, accumulated across cities and province cohorts.
    const countryProduction = zeroResources();
    const countryBuildCost = zeroResources();

    for (const city of ecoResult.cityResults) {
      await writeCity(client, runId, runCountryId, city, scenarioAbsHour);
      addInto(countryProduction, sumHourly(city.hourlyCityProduction));
      addInto(countryBuildCost, city.totalEcoBuildCost);
    }

    for (const cohort of provinceResults) {
      const { rows: cohortRows } = await client.query<{ id: string }>(
        `INSERT INTO eco_province_cohort
           (run_country_id, cohort_id, resource, province_count, build_sequence, hourly_production)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          runCountryId,
          cohort.cohortId,
          cohort.resource,
          cohort.provinceCount,
          JSON.stringify(cohort.bestActions),
          JSON.stringify(cohort.hourlyCohortProduction),
        ]
      );
      const cohortId = Number(cohortRows[0].id);

      await insertResourceFlow(
        client, runId, "province_cohort", cohortId, "production_total", cohort.totalProduction
      );
      await insertResourceFlow(
        client, runId, "province_cohort", cohortId, "eco_build_cost", cohort.totalEcoBuildCost
      );

      addInto(countryProduction, cohort.totalProduction);
      addInto(countryBuildCost, cohort.totalEcoBuildCost);
    }

    await insertResourceFlow(
      client, runId, "country", runCountryId, "production_total", countryProduction
    );
    await insertResourceFlow(
      client, runId, "country", runCountryId, "eco_build_cost", countryBuildCost
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(`Failed to persist eco result for ${input.countryId}`, { cause: err });
  } finally {
    client.release();
  }
}

async function writeCity(
  client: PoolClient,
  runId: number,
  runCountryId: number,
  city: CityEcoResult,
  scenarioAbsHour: number
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO run_city (run_country_id, city_id, city_name, resource, capital)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [runCountryId, bareCityId(city.cityId), city.cityName, city.resource, city.capital]
  );
  const runCityId = Number(rows[0].id);

  await client.query(
    `INSERT INTO eco_city_result
       (run_city_id, starting_levels, last_build_completion_abs_hour, explored, hourly_production)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      runCityId,
      JSON.stringify(city.startingLevels),
      city.lastEcoBuildCompletionAbsHour,
      city.explored,
      JSON.stringify(city.hourlyCityProduction),
    ]
  );

  for (const [i, action] of city.bestActions.entries()) {
    const { rel, abs } = actionHours(action, scenarioAbsHour);
    await client.query(
      `INSERT INTO eco_build_action
         (run_city_id, step_no, building_id, target_level, start_rel_hour, start_abs_hour)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [runCityId, i + 1, action.buildingId, action.targetLevel, rel, abs]
    );
  }

  for (const [i, step] of city.stepDeltas.entries()) {
    await client.query(
      `INSERT INTO eco_step_delta
         (run_city_id, step_no, building_id, target_level, start_hour, ${RESOURCE_COLUMNS.join(", ")})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        runCityId, i + 1, step.buildingId, step.targetLevel, step.startHour,
        ...resourceValues(step.delta),
      ]
    );
  }

  await insertResourceFlow(
    client, runId, "city", runCityId, "production_total", sumHourly(city.hourlyCityProduction)
  );
  await insertResourceFlow(
    client, runId, "city", runCityId, "eco_build_cost", city.totalEcoBuildCost
  );
}
