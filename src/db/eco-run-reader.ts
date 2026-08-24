import type { Resource } from "../core/constants.js";
import { pool } from "./pool.js";
import { RESOURCE_COLUMNS as RESOURCE_KEYS, resourceRowToMap, toNum, toNumOrNull, zeroResources } from "./resource-flow.js";

export type EcoRunSummary = {
  id: number;
  scenarioId: string;
  planId: string | null;
  truceDays: number;
  params: Record<string, unknown>;
  gitCommit: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type EcoPlanBuildActionData = {
  stepNo: number;
  buildingId: string;
  targetLevel: number;
  startAbsHour: number | null;
};

export type EcoPlanCityData = {
  cityId: string;
  cityName: string;
  resource: Resource;
  capital: boolean;
  lastBuildCompletionAbsHour: number | null;
  explored: number;
  buildActions: EcoPlanBuildActionData[];
  production: Partial<Record<Resource, number>>;
  buildCost: Partial<Record<Resource, number>>;
};

export type EcoPlanProvinceCohortData = {
  cohortId: string;
  resource: Resource | null;
  provinceCount: number;
  buildSequence: Array<{ buildingId: string; targetLevel: number }>;
  production: Partial<Record<Resource, number>>;
  buildCost: Partial<Record<Resource, number>>;
};

export type EcoPlanCountryData = {
  runId: number;
  countryId: string;
  countryName: string;
  doctrine: string;
  status: "homeland" | "occupied";
  captureDay: number | null;
  truceDays: number;
  beamWidth: number | null;
  cities: EcoPlanCityData[];
  provinceCohorts: EcoPlanProvinceCohortData[];
  countryProduction: Partial<Record<Resource, number>>;
  countryBuildCost: Partial<Record<Resource, number>>;
};

function mapRunRow(row: Record<string, unknown>): EcoRunSummary {
  return {
    id: Number(row.id),
    scenarioId: String(row.scenario_id),
    planId: (row.plan_id as string | null) ?? null,
    truceDays: Number(row.truce_days),
    params: (row.params as Record<string, unknown>) ?? {},
    gitCommit: (row.git_commit as string | null) ?? null,
    startedAt: String(row.started_at),
    finishedAt: (row.finished_at as string | null) ?? null,
  };
}

/** Most recent completed eco_plan run for a scenario (optionally narrowed to a plan). */
export async function findLatestFinishedEcoRun(opts: {
  scenarioId: string;
  planId?: string;
}): Promise<EcoRunSummary | null> {
  const conditions = ["unit = 'eco_plan'", "scenario_id = $1", "finished_at IS NOT NULL"];
  const params: unknown[] = [opts.scenarioId];
  if (opts.planId) {
    params.push(opts.planId);
    conditions.push(`plan_id = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT id, scenario_id, plan_id, truce_days, params, git_commit, started_at, finished_at
     FROM run WHERE ${conditions.join(" AND ")}
     ORDER BY started_at DESC LIMIT 1`,
    params
  );
  return rows.length ? mapRunRow(rows[0]) : null;
}

export async function getEcoRun(runId: number): Promise<EcoRunSummary | null> {
  const { rows } = await pool.query(
    `SELECT id, scenario_id, plan_id, truce_days, params, git_commit, started_at, finished_at
     FROM run WHERE id = $1 AND unit = 'eco_plan'`,
    [runId]
  );
  return rows.length ? mapRunRow(rows[0]) : null;
}

/** Country ids present in a run, in alphabetical order by display name. */
export async function listEcoRunCountryIds(runId: number): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT country_id FROM run_country WHERE run_id = $1 ORDER BY country_name`,
    [runId]
  );
  return rows.map(r => String(r.country_id));
}

/**
 * Reads everything one country needs to render its eco-plan report — cities,
 * their winning build sequences, province cohorts, and the resource_flow
 * totals already computed at write time (production / one-time build cost).
 * Pure read: no re-simulation, no scenario/country YAML access.
 */
export async function readEcoPlanCountryData(
  run: EcoRunSummary,
  countryId: string
): Promise<EcoPlanCountryData | null> {
  const { rows: countryRows } = await pool.query(
    `SELECT id, country_id, country_name, doctrine, status, capture_day
     FROM run_country WHERE run_id = $1 AND country_id = $2`,
    [run.id, countryId]
  );
  if (countryRows.length === 0) return null;
  const countryRow = countryRows[0];
  const runCountryId = Number(countryRow.id);

  const { rows: cityRows } = await pool.query(
    `SELECT rc.id, rc.city_id, rc.city_name, rc.resource, rc.capital,
            ecr.last_build_completion_abs_hour, ecr.explored
     FROM run_city rc
     JOIN eco_city_result ecr ON ecr.run_city_id = rc.id
     WHERE rc.run_country_id = $1
     ORDER BY rc.capital DESC, rc.city_name`,
    [runCountryId]
  );
  const cityIds = cityRows.map(r => Number(r.id));

  const buildActionRows = cityIds.length
    ? (
        await pool.query(
          `SELECT run_city_id, step_no, building_id, target_level, start_abs_hour
           FROM eco_build_action WHERE run_city_id = ANY($1) ORDER BY run_city_id, step_no`,
          [cityIds]
        )
      ).rows
    : [];
  const buildActionsByCity = new Map<number, EcoPlanBuildActionData[]>();
  for (const row of buildActionRows) {
    const id = Number(row.run_city_id);
    const arr = buildActionsByCity.get(id) ?? [];
    arr.push({
      stepNo: Number(row.step_no),
      buildingId: String(row.building_id),
      targetLevel: Number(row.target_level),
      startAbsHour: toNumOrNull(row.start_abs_hour),
    });
    buildActionsByCity.set(id, arr);
  }

  const cityFlowRows = cityIds.length
    ? (
        await pool.query(
          `SELECT scope_id, category, ${RESOURCE_KEYS.join(", ")}
           FROM resource_flow WHERE run_id = $1 AND scope_type = 'city' AND scope_id = ANY($2)`,
          [run.id, cityIds]
        )
      ).rows
    : [];
  const cityFlowByCity = new Map<number, Map<string, Partial<Record<Resource, number>>>>();
  for (const row of cityFlowRows) {
    const id = Number(row.scope_id);
    const byCategory = cityFlowByCity.get(id) ?? new Map();
    byCategory.set(String(row.category), resourceRowToMap(row));
    cityFlowByCity.set(id, byCategory);
  }

  const cities: EcoPlanCityData[] = cityRows.map(row => {
    const id = Number(row.id);
    const flows = cityFlowByCity.get(id);
    return {
      cityId: String(row.city_id),
      cityName: String(row.city_name),
      resource: row.resource as Resource,
      capital: Boolean(row.capital),
      lastBuildCompletionAbsHour: toNumOrNull(row.last_build_completion_abs_hour),
      explored: Number(row.explored),
      buildActions: buildActionsByCity.get(id) ?? [],
      production: flows?.get("production_total") ?? zeroResources(),
      buildCost: flows?.get("eco_build_cost") ?? zeroResources(),
    };
  });

  const { rows: cohortRows } = await pool.query(
    `SELECT id, cohort_id, resource, province_count, build_sequence
     FROM eco_province_cohort WHERE run_country_id = $1 ORDER BY cohort_id`,
    [runCountryId]
  );
  const cohortIds = cohortRows.map(r => Number(r.id));

  const cohortFlowRows = cohortIds.length
    ? (
        await pool.query(
          `SELECT scope_id, category, ${RESOURCE_KEYS.join(", ")}
           FROM resource_flow WHERE run_id = $1 AND scope_type = 'province_cohort' AND scope_id = ANY($2)`,
          [run.id, cohortIds]
        )
      ).rows
    : [];
  const cohortFlowByCohort = new Map<number, Map<string, Partial<Record<Resource, number>>>>();
  for (const row of cohortFlowRows) {
    const id = Number(row.scope_id);
    const byCategory = cohortFlowByCohort.get(id) ?? new Map();
    byCategory.set(String(row.category), resourceRowToMap(row));
    cohortFlowByCohort.set(id, byCategory);
  }

  const provinceCohorts: EcoPlanProvinceCohortData[] = cohortRows.map(row => {
    const id = Number(row.id);
    const flows = cohortFlowByCohort.get(id);
    const sequence = (row.build_sequence as Array<{ buildingId?: string; targetLevel?: number }>) ?? [];
    return {
      cohortId: String(row.cohort_id),
      resource: (row.resource as Resource | null) ?? null,
      provinceCount: Number(row.province_count),
      buildSequence: sequence.map(a => ({
        buildingId: String(a.buildingId ?? ""),
        targetLevel: Number(a.targetLevel ?? 0),
      })),
      production: flows?.get("production_total") ?? zeroResources(),
      buildCost: flows?.get("eco_build_cost") ?? zeroResources(),
    };
  });

  const { rows: countryFlowRows } = await pool.query(
    `SELECT category, ${RESOURCE_KEYS.join(", ")}
     FROM resource_flow WHERE run_id = $1 AND scope_type = 'country' AND scope_id = $2`,
    [run.id, runCountryId]
  );
  const countryFlowByCategory = new Map<string, Partial<Record<Resource, number>>>();
  for (const row of countryFlowRows) countryFlowByCategory.set(String(row.category), resourceRowToMap(row));

  const beamWidth = typeof run.params.beamWidth === "number" ? run.params.beamWidth : null;

  return {
    runId: run.id,
    countryId: String(countryRow.country_id),
    countryName: String(countryRow.country_name),
    doctrine: String(countryRow.doctrine),
    status: countryRow.status as "homeland" | "occupied",
    captureDay: countryRow.capture_day === null ? null : Number(countryRow.capture_day),
    truceDays: run.truceDays,
    beamWidth,
    cities,
    provinceCohorts,
    countryProduction: countryFlowByCategory.get("production_total") ?? zeroResources(),
    countryBuildCost: countryFlowByCategory.get("eco_build_cost") ?? zeroResources(),
  };
}
