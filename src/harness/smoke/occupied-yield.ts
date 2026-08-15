// Shared occupied-city/-province build-order + yield computation for the Iron
// Pipeline's occupied-country heuristic. Extracted out of iron-occupied-plan.ts
// so the same logic can be reused by iron-bp-plan.ts to compute a HOMELAND
// country's credited share of a captured territory's cities/provinces (see
// Demand.city_credits/province_credits, coalition-force-plan-schema.ts).
//
// RO1 (recruiting_office L1) is pushed first, unconditionally, in every
// included city's build order — ahead of the existing OCCUPIED_AI_TARGET_BY_RESOURCE
// annex+arms_industry heuristic (electronics-tile cities only; every other
// resource tile gets RO1 only). Manpower production is driven purely by
// population + RO building effects (see city-production.ts) — annexation and
// arms_industry never affect it — so RO1 is worth building everywhere captured,
// regardless of resource tile.
import type { Resource } from "../../core/constants.js";
import { CAPTURED_STARTING_MORALE_DAY1, DEFAULT_MORALE_DECAY_D, HOMELAND_TARGET_MORALE } from "../../core/constants.js";
import { buildDailyProvinceResourceTable } from "../../engine/economy/province-production.js";
import {
  scheduleBuildSegments,
  type BuildAction,
  type BuildSegmentsByCity,
  type TimelineCityState,
} from "../../engine/orchestration/build-order-timeline.js";
import { buildProvinceCohortsFromCountry, type ProvinceCohort } from "../../engine/provinces/province-cohorts.js";
import { simulateBuildOrder, type CityState } from "../../engine/simulation/build-order-sim.js";
import {
  simulateProvinceBuildOrder,
  type ProvinceBuildAction,
} from "../../engine/simulation/province-build-order-sim.js";
import type { BuildingsFile } from "../../schemas/building-schema.js";
import type { Country } from "../../schemas/country-schema.js";
import type { ScenarioFile } from "../../schemas/scenario-schema.js";
import {
  OCCUPIED_AI_TARGET_BY_RESOURCE,
  OCCUPIED_CITY_EXTRA_FIRST_BUILD,
  OCCUPIED_PROVINCE_BUILD_ORDER,
} from "./iron-heuristic.js";

export const RESOURCE_KEYS: Resource[] = ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"];

export function zeroResources(): Record<Resource, number> {
  return { supplies: 0, components: 0, fuel: 0, rares: 0, electronics: 0, cash: 0, manpower: 0 };
}

export function addInto(target: Record<Resource, number>, src: Partial<Record<Resource, number>>): void {
  for (const r of RESOURCE_KEYS) target[r] += src[r] ?? 0;
}

export function buildingLevelCost(buildings: BuildingsFile, buildingId: string, level: number): Partial<Record<Resource, number>> {
  return buildings.buildings[buildingId as keyof typeof buildings.buildings]?.levels[String(level) as "1" | "2" | "3" | "4" | "5"]?.cost ?? {};
}

export type OccupiedYieldArgs = {
  country: Country;
  scenario: ScenarioFile;
  buildings: BuildingsFile;
  captureDay: number;
  // toAbsoluteHour(captureDay, 0) - scenarioAbsHour — passed in rather than
  // derived here so this module doesn't duplicate that formula; both callers
  // already compute it via core/time.js's toAbsoluteHour.
  captureRelHour: number;
  hoursToSimulate: number;
  truceDays: number;
  // Capital cities lose their starting air_base on the garrison-disband day (see
  // iron-bp-plan.ts's IRON_AIRPORT_DESTROY_DAY convention) — passed through
  // unchanged to simulateBuildOrder. Keyed by prefixed cityId ("countryId:cityId").
  forcedAirBaseDestructionAbsHour?: Record<string, number>;
  // Default: include every city. Return false to exclude a city entirely
  // (e.g. it's credited to a homeland country and should no longer appear in
  // the source occupied country's own report).
  cityIdFilter?: (bareCityId: string) => boolean;
  // Default: identity (full cohort count). Used to scope a province cohort down
  // to a specific credited share, or to subtract credited shares out of the
  // source occupied country's own remaining count.
  cohortCountOverride?: (cohortId: string, fullCount: number) => number;
};

export type OccupiedYieldResult = {
  segmentsByCity: BuildSegmentsByCity;
  cityYieldByCity: Map<string, Record<Resource, number>>;
  hourlyProductionByCity: Map<string, Array<Record<Resource, number>>>;
  cityEcoBuildCost: Record<Resource, number>;
  provinceCohorts: ProvinceCohort[]; // count-adjusted per cohortCountOverride
  provinceYieldByCohort: Array<{ cohortId: string; resource: string; provinceCount: number; total: Record<Resource, number> }>;
  provinceBuildCost: Record<Resource, number>;
  provinceCostEvents: Array<{ hour: number; cost: Partial<Record<Resource, number>> }>;
};

// cohortId is "${countryId}:${resource}_provinces" or "${countryId}:non_resource_provinces"
// (buildProvinceCohortsFromCountry's convention) — this maps it to the key
// province_credits/countryPlanSchema uses ("electronics", "non_resource", ...).
export function provinceCreditKeyFromCohortId(cohortId: string): string {
  const suffix = cohortId.split(":")[1] ?? cohortId;
  return suffix.replace(/_provinces$/, "");
}

export function computeOccupiedYield(args: OccupiedYieldArgs): OccupiedYieldResult {
  const { country, scenario, buildings, captureDay, captureRelHour, hoursToSimulate, truceDays } = args;
  const cityIdFilter = args.cityIdFilter ?? (() => true);
  const cohortCountOverride = args.cohortCountOverride ?? ((_cohortId, fullCount) => fullCount);

  const cities = country.cities.filter(city => cityIdFilter(city.id));

  // ── City build order: RO1 first (unconditional), then annex+AI5 for
  // electronics-tile cities only (OCCUPIED_AI_TARGET_BY_RESOURCE) ──────────
  const cityStates: TimelineCityState[] = cities.map(city => ({
    cityId: `${country.country.id}:${city.id}`,
    capital: city.capital,
    cityStatus: "occupied",
    countryId: country.country.id,
    buildings: {
      army_base: 0,
      air_base: city.starting.air_base,
      annex_city: 0,
      arms_industry: 0,
      combat_outpost: 0,
      local_industry: 0,
      military_hospital: 0,
      naval_base: city.starting.naval_base,
      recruiting_office: 0,
      relocate_headquarters: 0,
      underground_bunkers: city.starting.underground_bunkers,
    },
  }));

  const buildOrder: BuildAction[] = [];
  for (const city of cities) {
    const cityId = `${country.country.id}:${city.id}`;
    const extraFirstBuild = OCCUPIED_CITY_EXTRA_FIRST_BUILD[city.id];
    if (extraFirstBuild) {
      buildOrder.push({ cityId, buildingId: extraFirstBuild.buildingId, targetLevel: extraFirstBuild.targetLevel, startRelHour: captureRelHour });
    }
    buildOrder.push({ cityId, buildingId: "recruiting_office", targetLevel: 1, startRelHour: captureRelHour });
    const aiTarget = OCCUPIED_AI_TARGET_BY_RESOURCE[city.resource];
    if (aiTarget === undefined) continue;
    buildOrder.push({ cityId, buildingId: "annex_city", targetLevel: 1 });
    buildOrder.push({ cityId, buildingId: "arms_industry", targetLevel: aiTarget });
  }

  const segmentsByCity = scheduleBuildSegments({ cities: cityStates, buildOrder, buildings, scenario });

  // ── Resource balance inputs — full-window city simulation, capture-zeroed ──
  const fullCityStates: CityState[] = cities.map(city => ({
    cityId: `${country.country.id}:${city.id}`,
    countryId: country.country.id,
    capital: city.capital,
    resource: city.resource,
    startPop: city.population,
    cityStatus: "occupied",
    buildings: {
      army_base: 0,
      air_base: city.starting.air_base,
      annex_city: 0,
      arms_industry: 0,
      combat_outpost: 0,
      local_industry: 0,
      military_hospital: 0,
      naval_base: city.starting.naval_base,
      recruiting_office: 0,
      relocate_headquarters: 0,
      underground_bunkers: city.starting.underground_bunkers,
    },
  }));

  const citySimulation = simulateBuildOrder({
    cities: fullCityStates,
    buildOrder,
    buildings,
    scenario,
    hoursToSimulate,
    forcedAirBaseDestructionAbsHour: args.forcedAirBaseDestructionAbsHour,
  });

  const hourlyProductionByCity = new Map<string, Array<Record<Resource, number>>>();
  for (const city of cities) hourlyProductionByCity.set(`${country.country.id}:${city.id}`, []);
  for (const row of citySimulation.perHourPerCity) {
    const arr = hourlyProductionByCity.get(row.cityId);
    if (!arr) continue;
    arr[row.hour] = row.hour < captureRelHour ? zeroResources() : row.production;
  }

  const cityYieldByCity = new Map<string, Record<Resource, number>>();
  for (const city of cities) {
    const total = zeroResources();
    const hourly = hourlyProductionByCity.get(`${country.country.id}:${city.id}`) ?? [];
    for (const prod of hourly) if (prod) addInto(total, prod);
    cityYieldByCity.set(`${country.country.id}:${city.id}`, total);
  }

  const cityEcoBuildCost = zeroResources();
  for (const city of cities) {
    const extraFirstBuild = OCCUPIED_CITY_EXTRA_FIRST_BUILD[city.id];
    if (extraFirstBuild) {
      addInto(cityEcoBuildCost, buildingLevelCost(buildings, extraFirstBuild.buildingId, extraFirstBuild.targetLevel));
    }
    addInto(cityEcoBuildCost, buildingLevelCost(buildings, "recruiting_office", 1));
    const aiTarget = OCCUPIED_AI_TARGET_BY_RESOURCE[city.resource];
    if (aiTarget === undefined) continue;
    addInto(cityEcoBuildCost, buildingLevelCost(buildings, "annex_city", 1));
    for (let lvl = 1; lvl <= aiTarget; lvl++) addInto(cityEcoBuildCost, buildingLevelCost(buildings, "arms_industry", lvl));
  }

  // ── Province income + build cost — count-adjusted per cohortCountOverride ──
  const fullProvinceCohorts = buildProvinceCohortsFromCountry(country);
  const provinceCohorts: ProvinceCohort[] = fullProvinceCohorts.map(cohort => {
    const count = cohortCountOverride(cohort.cohortId, cohort.totalProvinceCount);
    return { ...cohort, totalProvinceCount: count, resourceProvinceCount: cohort.resource ? count : 0 };
  });

  const provinceIncome = zeroResources();
  const provinceBuildCost = zeroResources();
  const provinceCostEvents: Array<{ hour: number; cost: Partial<Record<Resource, number>> }> = [];
  const provinceYieldByCohort: Array<{ cohortId: string; resource: string; provinceCount: number; total: Record<Resource, number> }> = [];
  for (const cohort of provinceCohorts) {
    if (cohort.totalProvinceCount <= 0) {
      provinceYieldByCohort.push({ cohortId: cohort.cohortId, resource: cohort.resource ?? "—", provinceCount: 0, total: zeroResources() });
      continue;
    }
    const steps = (cohort.resource && OCCUPIED_PROVINCE_BUILD_ORDER[cohort.resource]) ?? [];
    const actions: ProvinceBuildAction[] = steps.map((s, i) => ({
      provinceId: cohort.provinceId,
      buildingId: s.buildingId,
      targetLevel: s.targetLevel,
      ...(i === 0 ? { startRelHour: captureRelHour } : {}),
    }));
    const simResult = simulateProvinceBuildOrder({
      provinces: [{ ...cohort, cityStatus: "occupied" }],
      buildOrder: actions,
      buildings,
      scenario,
      hoursToSimulate,
    });
    const provinceTimelineState: TimelineCityState = {
      cityId: cohort.provinceId,
      countryId: country.country.id,
      buildings: {
        army_base: 0, air_base: 0, annex_city: 0, arms_industry: 0,
        combat_outpost: 0, local_industry: 0, mercenary_outpost: 0,
        naval_base: 0, recruiting_office: 0, relocate_headquarters: 0, underground_bunkers: 0,
      },
    };
    const provinceSegments = scheduleBuildSegments({
      cities: [provinceTimelineState],
      buildOrder: actions.map(a => ({ cityId: a.provinceId, buildingId: a.buildingId, targetLevel: a.targetLevel, startRelHour: a.startRelHour })),
      buildings,
      scenario,
    });
    const psegs = provinceSegments.get(cohort.provinceId);
    for (const s of [...(psegs?.local_industry ?? []), ...(psegs?.combat_outpost ?? [])]) {
      provinceCostEvents.push({ hour: s.startMinute / 60, cost: buildingLevelCost(buildings, s.buildingId, s.toLevel) });
    }
    const cohortIncome = zeroResources();
    for (const row of simResult.perHourAggregate) {
      if (row.hour < captureRelHour) continue;
      addInto(cohortIncome, row.production);
    }
    // Manpower workaround (same as iron-eco-plan.ts / iron-occupied-plan.ts):
    // simulateProvinceBuildOrder floors production hourly, zeroing manpower for
    // small cohorts. Recompute from the daily-granularity table instead.
    const dailyManpower = buildDailyProvinceResourceTable(truceDays, scenario.speed, {
      resource: "manpower",
      provinceCount: cohort.totalProvinceCount,
      moraleParams: {
        S: CAPTURED_STARTING_MORALE_DAY1,
        T: HOMELAND_TARGET_MORALE,
        N: 0,
        D: DEFAULT_MORALE_DECAY_D,
      },
      cityStatus: "occupied",
    });
    cohortIncome.manpower = dailyManpower.rows
      .filter(row => row.day >= captureDay)
      .reduce((sum, row) => sum + row.amount, 0);

    addInto(provinceIncome, cohortIncome);
    for (const step of steps) addInto(provinceBuildCost, buildingLevelCost(buildings, step.buildingId, step.targetLevel));
    provinceYieldByCohort.push({
      cohortId: cohort.cohortId,
      resource: cohort.resource ?? "—",
      provinceCount: cohort.totalProvinceCount,
      total: cohortIncome,
    });
  }

  return {
    segmentsByCity,
    cityYieldByCity,
    hourlyProductionByCity,
    cityEcoBuildCost,
    provinceCohorts,
    provinceYieldByCohort,
    provinceBuildCost,
    provinceCostEvents,
  };
}
