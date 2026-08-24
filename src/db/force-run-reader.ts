import type { Resource } from "../core/constants.js";
import { pool } from "./pool.js";
import { RESOURCE_COLUMNS, resourceRowToMap, toNumOrNull, zeroResources } from "./resource-flow.js";

export type ForceRunSummary = {
  id: number;
  scenarioId: string;
  planId: string | null;
  truceDays: number;
  params: Record<string, unknown>;
  gitCommit: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type ForceInfraStepData = {
  stepNo: number;
  name: string;
  buildingId: string;
  fromLevel: number;
  toLevel: number;
  startHour: number;
  endHour: number;
  durH: number;
  cost: Partial<Record<Resource, number>>;
};

export type ForceMobStepData = {
  stepNo: number;
  unitId: string;
  count: number;
  level: number | null;
  startAbsHour: number;
  endAbsHour: number;
  durationHours: number;
};

export type ForceCitySlotData = {
  roLevel: number;
  primaryUnitId: string;
  infraOpenHour: number;
  flipPointAbsHour: number;
  mobQueue: unknown[];
  infraSteps: ForceInfraStepData[];
  mobSteps: ForceMobStepData[];
};

export type ForceProjectionCityData = {
  cityId: string;
  cityName: string;
  resource: Resource;
  capital: boolean;
  slot: ForceCitySlotData;
};

export type ForceResearchSegmentData = {
  stepNo: number;
  slot: number;
  unitId: string;
  level: number;
  unlockDay: number;
  startAbsHour: number;
  endAbsHourExclusive: number;
  durationHours: number;
  cost: Partial<Record<Resource, number>>;
};

export type ForceProvinceMobResultData = {
  stepNo: number;
  unitId: string;
  level: number;
  count: number;
  provinceCount: number;
  mercenaryOutpostRequiredLevel: number;
  mercenaryOutpostBuildHours: number;
  mobStartHour: number;
  completionHour: number;
  mobilizationDurationHours: number;
  tranches: unknown[];
  mercenaryOutpostBuildCost: Partial<Record<Resource, number>>;
  mobilizationCost: Partial<Record<Resource, number>>;
};

/** A mob step whose real, research-level-split mobEnd lands after the truce
 *  deadline — see force_overrun_demand's own SQL comment. */
export type ForceOverrunDemandData = {
  stepNo: number;
  unitId: string;
  cityId: string;
  level: number;
  mobEndAbsHour: number;
  deadlineAbsHour: number;
};

export type ForceProjectionCostBuckets = {
  infraRo: Partial<Record<Resource, number>>;
  infraBuildings: Partial<Record<Resource, number>>;
  mobilisation: Partial<Record<Resource, number>>;
  upkeep: Partial<Record<Resource, number>>;
  provinceMobilisation: Partial<Record<Resource, number>>;
  provinceUpkeep: Partial<Record<Resource, number>>;
  total: Partial<Record<Resource, number>>;
};

/**
 * Everything one country needs to render its plain force-projection report —
 * only cities with an assigned demand exist here at all (see
 * force-run-repository.ts: this is the plain force projection, not a tailored
 * eco build, so unassigned cities are never persisted in the first place).
 */
export type ForceProjectionCountryData = {
  runId: number;
  countryId: string;
  countryName: string;
  doctrine: string;
  status: "homeland" | "occupied";
  captureDay: number | null;
  truceDays: number;
  moraleAtStart: number;
  moraleAtDeadline: number;
  infeasible: boolean;
  reason: string | null;
  demandLabels: string[];
  skippedDemands: unknown[];
  missingDataDemands: unknown[];
  planWeights: Partial<Record<Resource, number>>;
  cities: ForceProjectionCityData[];
  researchSegments: ForceResearchSegmentData[];
  provinceMobResults: ForceProvinceMobResultData[];
  overrunDemands: ForceOverrunDemandData[];
  costs: ForceProjectionCostBuckets;
};

function mapRunRow(row: Record<string, unknown>): ForceRunSummary {
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

/** Most recent completed force_projection run for a scenario (optionally narrowed to a plan). */
export async function findLatestFinishedForceRun(opts: {
  scenarioId: string;
  planId?: string;
}): Promise<ForceRunSummary | null> {
  const conditions = ["unit = 'force_projection'", "scenario_id = $1", "finished_at IS NOT NULL"];
  const params: unknown[] = [opts.scenarioId];
  if (opts.planId) {
    conditions.push(`plan_id = $${params.length + 1}`);
    params.push(opts.planId);
  }
  const { rows } = await pool.query(
    `SELECT id, scenario_id, plan_id, truce_days, params, git_commit, started_at, finished_at
     FROM run WHERE ${conditions.join(" AND ")} ORDER BY started_at DESC LIMIT 1`,
    params
  );
  return rows.length ? mapRunRow(rows[0]) : null;
}

export async function getForceRun(runId: number): Promise<ForceRunSummary | null> {
  const { rows } = await pool.query(
    `SELECT id, scenario_id, plan_id, truce_days, params, git_commit, started_at, finished_at
     FROM run WHERE id = $1 AND unit = 'force_projection'`,
    [runId]
  );
  return rows.length ? mapRunRow(rows[0]) : null;
}

/** Country ids present in a run, in alphabetical order by display name. */
export async function listForceRunCountryIds(runId: number): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT country_id FROM run_country WHERE run_id = $1 ORDER BY country_name`,
    [runId]
  );
  return rows.map(r => String(r.country_id));
}

/**
 * Reads everything one country needs to render its force-projection report.
 * Pure read: no re-simulation, no scenario/country YAML access.
 */
export async function readForceProjectionCountryData(
  run: ForceRunSummary,
  countryId: string
): Promise<ForceProjectionCountryData | null> {
  const { rows: countryRows } = await pool.query(
    `SELECT id, country_id, country_name, doctrine, status, capture_day
     FROM run_country WHERE run_id = $1 AND country_id = $2`,
    [run.id, countryId]
  );
  if (countryRows.length === 0) return null;
  const countryRow = countryRows[0];
  const runCountryId = Number(countryRow.id);

  const { rows: resultRows } = await pool.query(
    `SELECT morale_at_start, morale_at_deadline, infeasible, reason,
            demand_labels, skipped_demands, missing_data_demands, plan_weights
     FROM force_country_result WHERE run_country_id = $1`,
    [runCountryId]
  );
  const resultRow = resultRows[0];

  const { rows: cityRows } = await pool.query(
    `SELECT rc.id, rc.city_id, rc.city_name, rc.resource, rc.capital,
            fcs.ro_level, fcs.primary_unit_id, fcs.infra_open_hour, fcs.flip_point_abs_hour, fcs.mob_queue
     FROM run_city rc
     JOIN force_city_slot fcs ON fcs.run_city_id = rc.id
     WHERE rc.run_country_id = $1
     ORDER BY rc.capital DESC, rc.city_name`,
    [runCountryId]
  );
  const cityIds = cityRows.map(r => Number(r.id));

  const infraStepRows = cityIds.length
    ? (
        await pool.query(
          `SELECT run_city_id, step_no, name, building_id, from_level, to_level,
                  start_hour, end_hour, dur_h, ${RESOURCE_COLUMNS.join(", ")}
           FROM force_infra_step WHERE run_city_id = ANY($1) AND kind = 'infra' ORDER BY run_city_id, step_no`,
          [cityIds]
        )
      ).rows
    : [];
  const infraStepsByCity = new Map<number, ForceInfraStepData[]>();
  for (const row of infraStepRows) {
    const id = Number(row.run_city_id);
    const arr = infraStepsByCity.get(id) ?? [];
    arr.push({
      stepNo: Number(row.step_no),
      name: String(row.name),
      buildingId: String(row.building_id),
      fromLevel: Number(row.from_level),
      toLevel: Number(row.to_level),
      startHour: Number(row.start_hour),
      endHour: Number(row.end_hour),
      durH: Number(row.dur_h),
      cost: resourceRowToMap(row),
    });
    infraStepsByCity.set(id, arr);
  }

  const mobStepRows = cityIds.length
    ? (
        await pool.query(
          `SELECT run_city_id, step_no, unit_id, count, level, start_abs_hour, end_abs_hour, duration_hours
           FROM force_mob_step WHERE run_city_id = ANY($1) ORDER BY run_city_id, step_no`,
          [cityIds]
        )
      ).rows
    : [];
  const mobStepsByCity = new Map<number, ForceMobStepData[]>();
  for (const row of mobStepRows) {
    const id = Number(row.run_city_id);
    const arr = mobStepsByCity.get(id) ?? [];
    arr.push({
      stepNo: Number(row.step_no),
      unitId: String(row.unit_id),
      count: Number(row.count),
      level: row.level === null ? null : Number(row.level),
      startAbsHour: Number(row.start_abs_hour),
      endAbsHour: Number(row.end_abs_hour),
      durationHours: Number(row.duration_hours),
    });
    mobStepsByCity.set(id, arr);
  }

  const cities: ForceProjectionCityData[] = cityRows.map(row => {
    const id = Number(row.id);
    return {
      cityId: String(row.city_id),
      cityName: String(row.city_name),
      resource: row.resource as Resource,
      capital: Boolean(row.capital),
      slot: {
        roLevel: Number(row.ro_level),
        primaryUnitId: String(row.primary_unit_id),
        infraOpenHour: Number(row.infra_open_hour),
        flipPointAbsHour: Number(row.flip_point_abs_hour),
        mobQueue: (row.mob_queue as unknown[]) ?? [],
        infraSteps: infraStepsByCity.get(id) ?? [],
        mobSteps: mobStepsByCity.get(id) ?? [],
      },
    };
  });

  const { rows: researchRows } = await pool.query(
    `SELECT step_no, slot, unit_id, level, unlock_day, start_abs_hour,
            end_abs_hour_exclusive, duration_hours, ${RESOURCE_COLUMNS.join(", ")}
     FROM force_research_segment WHERE run_country_id = $1 ORDER BY step_no`,
    [runCountryId]
  );
  const researchSegments: ForceResearchSegmentData[] = researchRows.map(row => ({
    stepNo: Number(row.step_no),
    slot: Number(row.slot),
    unitId: String(row.unit_id),
    level: Number(row.level),
    unlockDay: Number(row.unlock_day),
    startAbsHour: Number(row.start_abs_hour),
    endAbsHourExclusive: Number(row.end_abs_hour_exclusive),
    durationHours: Number(row.duration_hours),
    cost: resourceRowToMap(row),
  }));

  const { rows: provinceMobRows } = await pool.query(
    `SELECT step_no, unit_id, level, count, province_count,
            mercenary_outpost_required_level, mercenary_outpost_build_hours,
            mob_start_hour, completion_hour, mobilization_duration_hours, tranches,
            mercenary_outpost_build_cost_supplies, mercenary_outpost_build_cost_components,
            mercenary_outpost_build_cost_fuel, mercenary_outpost_build_cost_rares,
            mercenary_outpost_build_cost_electronics, mercenary_outpost_build_cost_cash,
            mercenary_outpost_build_cost_manpower,
            mobilization_cost_supplies, mobilization_cost_components, mobilization_cost_fuel,
            mobilization_cost_rares, mobilization_cost_electronics, mobilization_cost_cash,
            mobilization_cost_manpower
     FROM force_province_mob_result WHERE run_country_id = $1 ORDER BY step_no`,
    [runCountryId]
  );
  const provinceMobResults: ForceProvinceMobResultData[] = provinceMobRows.map(row => ({
    stepNo: Number(row.step_no),
    unitId: String(row.unit_id),
    level: Number(row.level),
    count: Number(row.count),
    provinceCount: Number(row.province_count),
    mercenaryOutpostRequiredLevel: Number(row.mercenary_outpost_required_level),
    mercenaryOutpostBuildHours: Number(row.mercenary_outpost_build_hours),
    mobStartHour: Number(row.mob_start_hour),
    completionHour: Number(row.completion_hour),
    mobilizationDurationHours: Number(row.mobilization_duration_hours),
    tranches: (row.tranches as unknown[]) ?? [],
    mercenaryOutpostBuildCost: {
      supplies: toNumOrNull(row.mercenary_outpost_build_cost_supplies) ?? 0,
      components: toNumOrNull(row.mercenary_outpost_build_cost_components) ?? 0,
      fuel: toNumOrNull(row.mercenary_outpost_build_cost_fuel) ?? 0,
      rares: toNumOrNull(row.mercenary_outpost_build_cost_rares) ?? 0,
      electronics: toNumOrNull(row.mercenary_outpost_build_cost_electronics) ?? 0,
      cash: toNumOrNull(row.mercenary_outpost_build_cost_cash) ?? 0,
      manpower: toNumOrNull(row.mercenary_outpost_build_cost_manpower) ?? 0,
    },
    mobilizationCost: {
      supplies: toNumOrNull(row.mobilization_cost_supplies) ?? 0,
      components: toNumOrNull(row.mobilization_cost_components) ?? 0,
      fuel: toNumOrNull(row.mobilization_cost_fuel) ?? 0,
      rares: toNumOrNull(row.mobilization_cost_rares) ?? 0,
      electronics: toNumOrNull(row.mobilization_cost_electronics) ?? 0,
      cash: toNumOrNull(row.mobilization_cost_cash) ?? 0,
      manpower: toNumOrNull(row.mobilization_cost_manpower) ?? 0,
    },
  }));

  const { rows: overrunRows } = await pool.query(
    `SELECT step_no, unit_id, city_id, level, mob_end_abs_hour, deadline_abs_hour
     FROM force_overrun_demand WHERE run_country_id = $1 ORDER BY step_no`,
    [runCountryId]
  );
  const overrunDemands: ForceOverrunDemandData[] = overrunRows.map(row => ({
    stepNo: Number(row.step_no),
    unitId: String(row.unit_id),
    cityId: String(row.city_id),
    level: Number(row.level),
    mobEndAbsHour: Number(row.mob_end_abs_hour),
    deadlineAbsHour: Number(row.deadline_abs_hour),
  }));

  const { rows: costFlowRows } = await pool.query(
    `SELECT category, ${RESOURCE_COLUMNS.join(", ")}
     FROM resource_flow WHERE run_id = $1 AND scope_type = 'country' AND scope_id = $2
       AND category IN ('infra_ro','infra_buildings','mobilisation','upkeep','province_mobilisation','province_upkeep','total')`,
    [run.id, runCountryId]
  );
  const costByCategory = new Map<string, Partial<Record<Resource, number>>>();
  for (const row of costFlowRows) costByCategory.set(String(row.category), resourceRowToMap(row));
  const costs: ForceProjectionCostBuckets = {
    infraRo: costByCategory.get("infra_ro") ?? zeroResources(),
    infraBuildings: costByCategory.get("infra_buildings") ?? zeroResources(),
    mobilisation: costByCategory.get("mobilisation") ?? zeroResources(),
    upkeep: costByCategory.get("upkeep") ?? zeroResources(),
    provinceMobilisation: costByCategory.get("province_mobilisation") ?? zeroResources(),
    provinceUpkeep: costByCategory.get("province_upkeep") ?? zeroResources(),
    total: costByCategory.get("total") ?? zeroResources(),
  };

  return {
    runId: run.id,
    countryId: String(countryRow.country_id),
    countryName: String(countryRow.country_name),
    doctrine: String(countryRow.doctrine),
    status: countryRow.status as "homeland" | "occupied",
    captureDay: countryRow.capture_day === null ? null : Number(countryRow.capture_day),
    truceDays: run.truceDays,
    moraleAtStart: Number(resultRow?.morale_at_start ?? 0),
    moraleAtDeadline: Number(resultRow?.morale_at_deadline ?? 0),
    infeasible: Boolean(resultRow?.infeasible ?? false),
    reason: (resultRow?.reason as string | null) ?? null,
    demandLabels: (resultRow?.demand_labels as string[]) ?? [],
    skippedDemands: (resultRow?.skipped_demands as unknown[]) ?? [],
    missingDataDemands: (resultRow?.missing_data_demands as unknown[]) ?? [],
    planWeights: (resultRow?.plan_weights as Partial<Record<Resource, number>>) ?? {},
    cities,
    researchSegments,
    provinceMobResults,
    overrunDemands,
    costs,
  };
}
