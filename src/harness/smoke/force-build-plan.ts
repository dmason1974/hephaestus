import path from "node:path";
import fs from "node:fs";

import type { Resource, StartingPopulation } from "../../core/constants.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import { buildCountryHourlyResourceBalanceTable } from "../../engine/reporting/country-resource-balance.js";
import { simulateBuildOrder, type CityState } from "../../engine/simulation/build-order-sim.js";
import { planMobilizationBuild, type MobilizationDemand, type MobilizationPlanResult } from "../../engine/simulation/unit-mobilization-plan.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadForcePlanFile, loadScenarioForcePlan } from "../../scenarios/io/load-force-plan.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadMergedUnitCatalogForScenario } from "../../scenarios/io/load-unit-catalog.js";
import type { BuildingsFile } from "../../schemas/building-schema.js";
import type { UnitCatalog } from "../../schemas/unit-schema.js";
import type { BuildingId } from "../../engine/orchestration/build-order-timeline.js";

type QueueType = "air" | "naval" | "land" | "loadout";
type CountryCity = ReturnType<typeof loadScenarioCountry>["cities"][number];
type QueueProfileSummary = {
  queueKey: string;
  queueType: QueueType;
  cityCount: number;
  requiredBaseLevel: number;
  requiredArmyBaseLevel: number;
  requiredRecruitingOfficeLevel: number;
  armsIndustryTargetLevel: number;
  candidateCities: CountryCity[];
};
type QueueChoice = {
  queueKey: string;
  queueType: QueueType;
  cityCount: number;
  recruitingOfficeLevel: number;
  armsIndustryLevel: number;
};
type CityBuildPlan = {
  queueKey: string;
  queueType: QueueType;
  city: CountryCity;
  cityIndex: number;
  buildSteps: string[];
  totalCost: Record<Resource, number>;
  lastCompletionAbsoluteHour: number;
  firstMobilizationStartAbsoluteHour: number | null;
  buildActions: Array<{
    cityId: string;
    buildingId: "arms_industry" | "air_base" | "naval_base" | "army_base" | "secret_weapons_lab" | "recruiting_office";
    targetLevel: number;
  }>;
  timingRows: Array<{
    buildingId: string;
    fromLevel: number;
    toLevel: number;
    startRelHour: number;
    startAbsoluteHour: number;
    startDay: number;
    startHour: number;
    completionDay: number;
    completionHour: number;
    durationHours: number;
  }>;
};
type SpendingRow = {
  absoluteHour: number;
  label: string;
  cost: Record<Resource, number>;
};
type TimedBuildCostRow = {
  cityId: string;
  buildingId: "arms_industry" | "air_base" | "naval_base" | "army_base" | "recruiting_office" | "relocate_headquarters" | "underground_bunkers";
  toLevel: number;
  startAbsoluteHour: number;
};
type AffordabilityResult = {
  affordable: boolean;
  spendingRows: SpendingRow[];
  endingBalances: Record<Resource, number>;
  minimumBalances: Record<Resource, number>;
  firstDeficitByResource: Partial<Record<Resource, {
    absoluteHour: number;
    day: number;
    hour: number;
    balance: number;
  }>>;
  cumulativeDeficitByResource: Record<Resource, number>;
  firstDeficit: {
    absoluteHour: number;
    day: number;
    hour: number;
    resource: Resource;
    balance: number;
  } | null;
};
type EcoAction = {
  cityId: string;
  buildingId: EcoBuildingId;
  targetLevel: number;
};
type EcoSupportResult = {
  foundAffordablePath: boolean;
  actions: EcoAction[];
  timedRows: Array<{
    cityId: string;
    buildingId: EcoBuildingId;
    toLevel: number;
    startDay: number;
    startHour: number;
    completionDay: number;
    completionHour: number;
  }>;
  extraCost: Record<Resource, number>;
  affordability: AffordabilityResult;
};
type EvaluatedOption = {
  choices: QueueChoice[];
  plan: MobilizationPlanResult;
  profiles: QueueProfileSummary[];
  cityBuildPlans: CityBuildPlan[];
  totalCities: number;
  totalRecruitingOfficeLevels: number;
  totalArmsIndustryLevels: number;
  totalReadyHoursBeforeWar: number;
  infrastructureCost: Record<Resource, number>;
  mobilisationCost: Record<Resource, number>;
  preWarUpkeep: Record<Resource, number>;
  latestResearchEndAbsoluteHour: number;
  latestMobilizationEndAbsoluteHour: number;
  totalEconomicCost: number;
  affordability: AffordabilityResult;
  ecoSupport: EcoSupportResult | null;
};

type CityMobilizationSummaryRow = {
  unitId: string;
  mobilizeLevel: number;
  count: number;
  firstStartDay: number;
  firstStartHour: number;
  lastEndDay: number;
  lastEndHour: number;
};

type EcoBuildingId =
  | "arms_industry"
  | "air_base"
  | "naval_base"
  | "relocate_headquarters"
  | "underground_bunkers";

type EcoBuildingLevels = Record<EcoBuildingId, number>;

const RESOURCE_KEYS: Resource[] = [
  "supplies",
  "components",
  "fuel",
  "rares",
  "electronics",
  "cash",
  "manpower",
];

const MAX_BUILDING_LEVEL = 5;

function parsePositiveInt(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function zeroResources() {
  return {
    supplies: 0,
    components: 0,
    fuel: 0,
    rares: 0,
    electronics: 0,
    cash: 0,
    manpower: 0,
  } satisfies Record<Resource, number>;
}

function addResources(target: Record<Resource, number>, addend: Partial<Record<Resource, number>>) {
  for (const resource of RESOURCE_KEYS) {
    target[resource] += addend[resource] ?? 0;
  }
}

function scaleResources(source: Record<Resource, number>, factor: number) {
  const scaled = zeroResources();
  for (const resource of RESOURCE_KEYS) {
    scaled[resource] = source[resource] * factor;
  }
  return scaled;
}

function mapDayForAbsoluteHour(absoluteHour: number) {
  return Math.floor(absoluteHour / 24) + 1;
}

function hourOfDayForAbsoluteHour(absoluteHour: number) {
  return absoluteHour % 24;
}

function compareTuple(a: readonly (string | number)[], b: readonly (string | number)[]) {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index];
    const right = b[index];
    if (left === right) continue;
    if (typeof left === "number" && typeof right === "number") {
      return left - right;
    }
    return String(left).localeCompare(String(right));
  }
  return 0;
}

function parseLevelRequirement(requirement: string) {
  const match = requirement.trim().match(/^(.+?)\s+level\s+(\d+)$/i);
  if (!match) return null;
  return {
    id: match[1]?.trim() ?? "",
    level: Number(match[2]),
  };
}

function queueTypeForUnit(catalog: UnitCatalog, unitId: string): QueueType {
  const unit = catalog.units[unitId];
  if (!unit) {
    throw new Error(`unknown unit "${unitId}"`);
  }

  const category = unit.category.trim().toLowerCase();
  const firstLevel = unit.levels[String(Math.min(...Object.keys(unit.levels).map(level => Number(level))))];
  const hasRequirement = (id: string) => firstLevel?.requirements.some(requirement => {
    const parsed = parseLevelRequirement(requirement);
    return parsed?.id === id;
  }) ?? false;

  if (hasRequirement("naval_base") || category === "naval") return "naval";
  if (hasRequirement("air_base") || category === "air") return "air";
  if (hasRequirement("army_base") || category === "infantry" || category === "support") return "land";
  return "loadout";
}

function queueKeyForDemand(catalog: UnitCatalog, demand: MobilizationDemand) {
  const queueType = queueTypeForUnit(catalog, demand.unitId);
  return `${queueType}:${demand.queueGroup ?? demand.unitId}`;
}

function parseDemandList(envValue: string | undefined) {
  if (!envValue) return null;

  const parsed = envValue
    .split(",")
    .map(token => token.trim())
    .filter(Boolean)
    .map(token => {
      const [unitId, countRaw] = token.split(/[:=]/, 2);
      if (!unitId || !countRaw) {
        throw new Error(`invalid PLAN_DEMANDS token "${token}", expected unit_id:count`);
      }
      const count = Number.parseInt(countRaw, 10);
      if (!Number.isFinite(count) || count < 0) {
        throw new Error(`invalid demand count "${countRaw}" for ${unitId}`);
      }
      return { unitId, count };
    });

  return parsed.filter(demand => demand.count > 0);
}

function buildingCost(
  buildings: BuildingsFile,
  buildingId: "arms_industry" | "air_base" | "naval_base" | "army_base" | "secret_weapons_lab" | "recruiting_office" | "relocate_headquarters" | "underground_bunkers",
  targetLevel: number
) {
  const levelData = buildings.buildings[buildingId]?.levels[String(targetLevel) as "1" | "2" | "3" | "4" | "5"];
  if (!levelData) {
    throw new Error(`missing ${buildingId} level ${targetLevel}`);
  }
  return levelData.cost;
}

function maxDefinedBuildingLevel(buildingId: EcoBuildingId) {
  const levels = Object.keys(buildings.buildings[buildingId]?.levels ?? {}).map(level => Number(level));
  return levels.length > 0 ? Math.max(...levels) : 0;
}

function zeroEcoBuildingLevels(): EcoBuildingLevels {
  return {
    arms_industry: 0,
    air_base: 0,
    naval_base: 0,
    relocate_headquarters: 0,
    underground_bunkers: 0,
  };
}

function candidateScore(queueType: QueueType, city: CountryCity) {
  if (queueType === "air") {
    const resourceScore =
      city.resource === "electronics" ? 0 :
      city.resource === "supplies" ? 1 :
      city.resource === "components" ? 2 :
      city.resource === "fuel" ? 3 :
      city.resource === "rares" ? 4 :
      5;
    return [
      city.starting.air_base > 0 ? 0 : 1,
      resourceScore,
      city.capital ? 0 : 1,
      -city.population,
      city.name,
    ] as const;
  }

  if (queueType === "naval") {
    const resourceScore =
      city.resource === "electronics" ? 0 :
      city.resource === "components" ? 1 :
      city.resource === "supplies" ? 2 :
      city.resource === "fuel" ? 3 :
      city.resource === "rares" ? 4 :
      5;
    return [
      city.starting.naval_base > 0 ? 0 : 1,
      resourceScore,
      city.capital ? 0 : 1,
      -city.population,
      city.name,
    ] as const;
  }

  const manpowerScore =
    city.resource === "supplies" ? 0 :
    city.resource === "components" ? 1 :
    city.resource === "electronics" ? 2 :
    city.resource === "fuel" ? 3 :
    city.resource === "rares" ? 4 :
    5;
  return [
    city.capital ? 0 : 1,
    manpowerScore,
    -city.population,
    city.name,
  ] as const;
}

function candidateCitiesForQueueType(country: ReturnType<typeof loadScenarioCountry>, queueType: QueueType) {
  const filtered =
    queueType === "naval"
      ? country.cities.filter(city => city.starting.naval_base > 0)
      : country.cities.slice();

  return filtered.sort((a, b) => compareTuple(candidateScore(queueType, a), candidateScore(queueType, b)));
}

function buildCityState(city: CountryCity): CityState {
  return {
    cityId: `${country.country.id}:${city.id}`,
    countryId: country.country.id,
    capital: city.capital,
    resource: city.resource,
    startPop: city.population as StartingPopulation,
    cityStatus: "homeland",
    buildings: {
      army_base: 0,
      air_base: city.starting.air_base,
      annex_city: 0,
      arms_industry: 0,
      combat_outpost: 0,
      local_industry: 0,
      naval_base: city.starting.naval_base,
      recruiting_office: 0,
      relocate_headquarters: 0,
      underground_bunkers: city.starting.underground_bunkers,
    },
  };
}

function buildPlanActionsForCity(
  city: CountryCity,
  queueType: QueueType,
  requiredBaseLevel: number,
  requiredArmyBaseLevel: number,
  requiredRecruitingOfficeLevel: number,
  requiresSecretWeaponsLab: boolean,
  armsIndustryTargetLevel: number
) {
  const actions: Array<{
    buildingId: "arms_industry" | "air_base" | "naval_base" | "army_base" | "secret_weapons_lab" | "recruiting_office";
    targetLevel: number;
  }> = [];

  for (let level = 1; level <= armsIndustryTargetLevel; level++) {
    actions.push({ buildingId: "arms_industry", targetLevel: level });
  }

  if (queueType === "air" && city.starting.air_base < requiredBaseLevel) {
    for (let level = city.starting.air_base + 1; level <= requiredBaseLevel; level++) {
      actions.push({ buildingId: "air_base", targetLevel: level });
    }
  }

  if (queueType === "naval" && city.starting.naval_base < requiredBaseLevel) {
    for (let level = city.starting.naval_base + 1; level <= requiredBaseLevel; level++) {
      actions.push({ buildingId: "naval_base", targetLevel: level });
    }
  }

  if (requiredArmyBaseLevel > 0) {
    for (let level = 1; level <= requiredArmyBaseLevel; level++) {
      actions.push({ buildingId: "army_base", targetLevel: level });
    }
  }

  if (requiresSecretWeaponsLab) {
    actions.push({ buildingId: "secret_weapons_lab", targetLevel: 1 });
  }

  if (requiredRecruitingOfficeLevel > 0) {
    for (let level = 1; level <= requiredRecruitingOfficeLevel; level++) {
      actions.push({ buildingId: "recruiting_office", targetLevel: level });
    }
  }

  return actions.map(action => ({
    cityId: `${country.country.id}:${city.id}`,
    buildingId: action.buildingId,
    targetLevel: action.targetLevel,
  }));
}

function buildStepsForCity(
  city: CountryCity,
  queueType: QueueType,
  requiredBaseLevel: number,
  requiredArmyBaseLevel: number,
  requiredRecruitingOfficeLevel: number,
  requiresSecretWeaponsLab: boolean,
  armsIndustryTargetLevel: number
) {
  const steps: string[] = [`arms_industry -> level ${armsIndustryTargetLevel}`];

  if (queueType === "air" && city.starting.air_base < requiredBaseLevel) {
    steps.push(`air_base -> level ${requiredBaseLevel}`);
  }
  if (queueType === "naval" && city.starting.naval_base < requiredBaseLevel) {
    steps.push(`naval_base -> level ${requiredBaseLevel}`);
  }
  if (requiredArmyBaseLevel > 0) {
    steps.push(`army_base -> level ${requiredArmyBaseLevel}`);
  }
  if (requiresSecretWeaponsLab) {
    steps.push("secret_weapons_lab -> level 1");
  }
  if (requiredRecruitingOfficeLevel > 0) {
    steps.push(`recruiting_office -> level ${requiredRecruitingOfficeLevel}`);
  }

  return steps;
}

function planInfrastructureForProfiles(
  profiles: QueueProfileSummary[],
  plan: MobilizationPlanResult,
  scenarioStartHour: number,
  truceLengthDays: number
) {
  const earliestStartByQueueCity = new Map<string, number>();
  for (const segment of plan.segments) {
    const key = `${segment.queueKey}:${segment.cityIndex}`;
    earliestStartByQueueCity.set(
      key,
      Math.min(earliestStartByQueueCity.get(key) ?? Number.POSITIVE_INFINITY, segment.startAbsoluteHour)
    );
  }

  const cityBuildPlans: CityBuildPlan[] = [];
  const totalCost = zeroResources();

  for (const profile of profiles) {
    const queueDemands = demands.filter(d => queueKeyForDemand(catalog, d) === profile.queueKey);
    const requiresSecretWeaponsLab = queueDemands.some(d =>
      Object.values(catalog.units[d.unitId]?.levels ?? {}).some(level =>
        level.requirements.some(r => parseLevelRequirement(r)?.id === "secret_weapons_lab")
      )
    );

    profile.candidateCities.forEach((city, index) => {
      const buildOrder = buildPlanActionsForCity(
        city,
        profile.queueType,
        profile.requiredBaseLevel,
        profile.requiredArmyBaseLevel,
        profile.requiredRecruitingOfficeLevel,
        requiresSecretWeaponsLab,
        profile.armsIndustryTargetLevel
      );
      const simulation = simulateBuildOrder({
        cities: [buildCityState(city)],
        buildOrder,
        buildings,
        scenario,
        hoursToSimulate: truceLengthDays * 24,
      });

      const cityCost = zeroResources();
      for (const action of buildOrder) {
        addResources(cityCost, buildingCost(buildings, action.buildingId, action.targetLevel));
      }
      addResources(totalCost, cityCost);

      const timingRows = (simulation.timingDebug?.builds ?? []).map(build => ({
        buildingId: build.buildingId,
        fromLevel: build.fromLevel,
        toLevel: build.toLevel,
        startRelHour: build.startRelHour,
        startDay: mapDayForAbsoluteHour(scenarioStartHour + build.startRelHour),
        startHour: hourOfDayForAbsoluteHour(scenarioStartHour + build.startRelHour),
        completionDay: mapDayForAbsoluteHour(build.completionAbs),
        completionHour: hourOfDayForAbsoluteHour(build.completionAbs),
        durationHours: Number(build.durationHours.toFixed(2)),
      }));

      cityBuildPlans.push({
        queueKey: profile.queueKey,
        queueType: profile.queueType,
        city,
        cityIndex: index + 1,
        buildSteps: buildStepsForCity(
          city,
          profile.queueType,
          profile.requiredBaseLevel,
          profile.requiredArmyBaseLevel,
          profile.requiredRecruitingOfficeLevel,
          requiresSecretWeaponsLab,
          profile.armsIndustryTargetLevel
        ),
        totalCost: cityCost,
        lastCompletionAbsoluteHour: timingRows.length > 0
          ? Math.max(...timingRows.map(row => ((row.completionDay - 1) * 24) + row.completionHour))
          : scenarioStartHour,
        firstMobilizationStartAbsoluteHour: earliestStartByQueueCity.get(`${profile.queueKey}:${index + 1}`) ?? null,
        buildActions: buildOrder,
        timingRows,
      });
    });
  }

  return {
    cityBuildPlans,
    totalCost,
  };
}

function preWarUpkeepForPlan(catalog: UnitCatalog, plan: MobilizationPlanResult, deadlineAbsoluteHour: number) {
  const totals = zeroResources();
  let readyHours = 0;

  for (const segment of plan.segments) {
    const unitLevel = catalog.units[segment.unitId]?.levels[String(segment.mobilizeLevel)];
    if (!unitLevel) {
      throw new Error(`missing upkeep data for ${segment.unitId} level ${segment.mobilizeLevel}`);
    }
    const completedHoursBeforeWar = Math.max(0, deadlineAbsoluteHour - segment.endAbsoluteHourExclusive);
    readyHours += completedHoursBeforeWar;
    const upkeepCost = { ...zeroResources(), ...(unitLevel.daily_upkeep[country.country.doctrine]?.cost ?? {}) };
    addResources(totals, scaleResources(upkeepCost, completedHoursBeforeWar / 24));
  }

  return {
    totals,
    readyHours,
  };
}

function totalResourceCost(cost: Record<Resource, number>) {
  return RESOURCE_KEYS.reduce((sum, resource) => sum + cost[resource], 0);
}

function buildAllCityStates() {
  return country.cities.map(city => buildCityState(city));
}

function timedBuildRowsFromSimulation(simulation: ReturnType<typeof simulateBuildOrder>): TimedBuildCostRow[] {
  return (simulation.timingDebug?.builds ?? []).map(build => ({
    cityId: build.cityId,
    buildingId: build.buildingId as TimedBuildCostRow["buildingId"],
    toLevel: build.toLevel,
    startAbsoluteHour: scenarioStartHour + build.startRelHour,
  }));
}

function hourlyDeltasFromCountryTable(table: ReturnType<typeof buildCountryHourlyResourceBalanceTable>) {
  return table.rows.map((row, index) => {
    const previous = index === 0 ? undefined : table.rows[index - 1]?.balances;
    const delta = zeroResources();
    for (const resource of RESOURCE_KEYS) {
      const currentValue = row.balances[resource] ?? 0;
      const previousValue = previous?.[resource] ?? 0;
      delta[resource] = currentValue - previousValue;
    }
    return delta;
  });
}

function buildAffordabilityResult(args: {
  plan: MobilizationPlanResult;
  buildCosts: TimedBuildCostRow[];
  hourlyIncome: Array<Record<Resource, number>>;
  hoursToSimulate: number;
}) : AffordabilityResult {
  const spendingRows: SpendingRow[] = [];

  for (const researchSpend of args.plan.researchPlan.spendingByAbsoluteHour) {
    spendingRows.push({
      absoluteHour: researchSpend.absoluteHour,
      label: "research",
      cost: { ...researchSpend.cost },
    });
  }

  for (const row of args.buildCosts) {
    spendingRows.push({
      absoluteHour: row.startAbsoluteHour,
      label: `${row.cityId}:${row.buildingId}:${row.toLevel}`,
      cost: buildingCost(buildings, row.buildingId, row.toLevel),
    });
  }

  for (const segment of args.plan.segments) {
    const unitLevel = catalog.units[segment.unitId]?.levels[String(segment.mobilizeLevel)];
    if (!unitLevel) {
      throw new Error(`missing mobilisation cost for ${segment.unitId} level ${segment.mobilizeLevel}`);
    }
    spendingRows.push({
      absoluteHour: segment.startAbsoluteHour,
      label: `${segment.queueKey}:${segment.unitId}:${segment.mobilizeLevel}`,
      cost: unitLevel.mobilisation[country.country.doctrine]?.cost ?? {},
    });
  }

  spendingRows.sort((a, b) => a.absoluteHour - b.absoluteHour || a.label.localeCompare(b.label));

  const spendByHour = new Map<number, Record<Resource, number>>();
  for (const row of spendingRows) {
    const bucket = spendByHour.get(row.absoluteHour) ?? zeroResources();
    addResources(bucket, row.cost);
    spendByHour.set(row.absoluteHour, bucket);
  }

  const balances = {
    supplies: scenario.starting_balance.supplies,
    components: scenario.starting_balance.components,
    fuel: scenario.starting_balance.fuel,
    rares: scenario.starting_balance.rares,
    electronics: scenario.starting_balance.electronics,
    cash: scenario.starting_balance.cash,
    manpower: scenario.starting_balance.manpower,
  } satisfies Record<Resource, number>;
  const minimumBalances = { ...balances };
  const firstDeficitByResource: AffordabilityResult["firstDeficitByResource"] = {};
  const cumulativeDeficitByResource = zeroResources();
  let firstDeficit: AffordabilityResult["firstDeficit"] = null;

  for (let relHour = 0; relHour < args.hoursToSimulate; relHour++) {
    const absoluteHour = scenarioStartHour + relHour;
    const spend = spendByHour.get(absoluteHour);
    if (spend) {
      for (const resource of RESOURCE_KEYS) {
        balances[resource] -= spend[resource];
        minimumBalances[resource] = Math.min(minimumBalances[resource], balances[resource]);
        if (firstDeficit === null && balances[resource] < 0) {
          firstDeficit = {
            absoluteHour,
            day: mapDayForAbsoluteHour(absoluteHour),
            hour: hourOfDayForAbsoluteHour(absoluteHour),
            resource,
            balance: balances[resource],
          };
        }
        if (balances[resource] < 0) {
          firstDeficitByResource[resource] ??= {
            absoluteHour,
            day: mapDayForAbsoluteHour(absoluteHour),
            hour: hourOfDayForAbsoluteHour(absoluteHour),
            balance: balances[resource],
          };
          cumulativeDeficitByResource[resource] += -balances[resource];
        }
      }
    }

    const income = args.hourlyIncome[relHour];
    if (income) {
      addResources(balances, income);
      for (const resource of RESOURCE_KEYS) {
        minimumBalances[resource] = Math.min(minimumBalances[resource], balances[resource]);
      }
    }
  }

  return {
    affordable: firstDeficit === null,
    spendingRows,
    endingBalances: balances,
    minimumBalances,
    firstDeficitByResource,
    cumulativeDeficitByResource,
    firstDeficit,
  };
}

function deficitScore(result: AffordabilityResult) {
  return RESOURCE_KEYS.reduce((sum, resource) => sum + Math.max(0, -result.minimumBalances[resource]), 0);
}

function ecoSupportSearch(option: Pick<EvaluatedOption, "plan" | "cityBuildPlans" | "affordability">): EcoSupportResult | null {
  if (option.affordability.affordable) return null;

  const beamWidth = parsePositiveInt(process.env.PLAN_ECO_BEAM_WIDTH, 40);
  const maxActions = parsePositiveInt(process.env.PLAN_ECO_MAX_ACTIONS, 10);
  const prioritizedCityIds = Array.from(
    new Set([
      ...option.cityBuildPlans.map(cityPlan => `${country.country.id}:${cityPlan.city.id}`),
      ...candidateCitiesForQueueType(country, "air").map(city => `${country.country.id}:${city.id}`),
      ...candidateCitiesForQueueType(country, "naval").map(city => `${country.country.id}:${city.id}`),
      ...country.cities
        .slice()
        .sort((a, b) => {
          const resourceScore = (city: CountryCity) =>
            city.resource === "electronics" ? 0 :
            city.resource === "rares" ? 1 :
            city.resource === "components" ? 2 :
            city.resource === "supplies" ? 3 :
            city.resource === "fuel" ? 4 :
            5;
          return (
            resourceScore(a) - resourceScore(b) ||
            (Number(b.capital) - Number(a.capital)) ||
            (b.population - a.population) ||
            a.name.localeCompare(b.name)
          );
        })
        .map(city => `${country.country.id}:${city.id}`),
    ])
  );
  const cityById = new Map(country.cities.map(city => [`${country.country.id}:${city.id}`, city]));

  const baseBuildOrder = option.cityBuildPlans.flatMap(cityPlan => cityPlan.buildActions);
  const baseLevelsByCity = new Map<string, EcoBuildingLevels>(
    country.cities.map(city => [
      `${country.country.id}:${city.id}`,
      {
        arms_industry: 0,
        air_base: city.starting.air_base,
        naval_base: city.starting.naval_base,
        relocate_headquarters: 0,
        underground_bunkers: city.starting.underground_bunkers,
      },
    ])
  );
  for (const action of baseBuildOrder) {
    if (
      action.buildingId !== "arms_industry" &&
      action.buildingId !== "air_base" &&
      action.buildingId !== "naval_base" &&
      action.buildingId !== "relocate_headquarters" &&
      action.buildingId !== "underground_bunkers"
    ) {
      continue;
    }
    const levels = baseLevelsByCity.get(action.cityId) ?? zeroEcoBuildingLevels();
    levels[action.buildingId] = Math.max(levels[action.buildingId], action.targetLevel);
    baseLevelsByCity.set(action.cityId, levels);
  }

  type BeamState = {
    actions: EcoAction[];
    affordability: AffordabilityResult;
    extraCost: Record<Resource, number>;
    simulation: ReturnType<typeof simulateBuildOrder>;
  };

  function compareBeamState(a: BeamState, b: BeamState) {
    return (
      (Number(b.affordability.affordable) - Number(a.affordability.affordable)) ||
      (deficitScore(a.affordability) - deficitScore(b.affordability)) ||
      (totalResourceCost(a.extraCost) - totalResourceCost(b.extraCost)) ||
      (a.actions.length - b.actions.length) ||
      a.actions.map(action => `${action.cityId}:${action.buildingId}:${action.targetLevel}`).join("|")
        .localeCompare(b.actions.map(action => `${action.cityId}:${action.buildingId}:${action.targetLevel}`).join("|"))
    );
  }

  let beam: BeamState[] = [{
    actions: [],
    affordability: option.affordability,
    extraCost: zeroResources(),
    simulation: simulateBuildOrder({
      cities: buildAllCityStates(),
      buildOrder: baseBuildOrder,
      buildings,
      scenario,
      hoursToSimulate: truceLengthDays * 24,
    }),
  }];

  progress(
    `starting eco support search: beamWidth=${beamWidth}, maxActions=${maxActions}, ` +
    `baselineDeficit=${Number(deficitScore(option.affordability).toFixed(2))}`
  );

  for (let depth = 0; depth < maxActions; depth++) {
    const nextBeam: BeamState[] = [];
    const seen = new Set<string>();

    for (const state of beam) {
      if (state.affordability.affordable) {
        nextBeam.push(state);
        continue;
      }

      const currentLevelsByCity = new Map<string, EcoBuildingLevels>(
        Array.from(baseLevelsByCity.entries()).map(([cityId, levels]) => [cityId, { ...levels }])
      );
      for (const action of state.actions) {
        const levels = currentLevelsByCity.get(action.cityId) ?? zeroEcoBuildingLevels();
        levels[action.buildingId] = action.targetLevel;
        currentLevelsByCity.set(action.cityId, levels);
      }

      for (const cityId of prioritizedCityIds) {
        const city = cityById.get(cityId);
        if (!city) continue;
        const levels = currentLevelsByCity.get(cityId) ?? zeroEcoBuildingLevels();
        const deficitResources = new Set<Resource>(
          RESOURCE_KEYS.filter(r => (state.affordability.minimumBalances[r] ?? 0) < 0)
        );
        const candidateBuildingIds = ([
          "arms_industry",
          "air_base",
          ...(levels.naval_base > 0 ? ["naval_base" as const] : []),
        ] as EcoBuildingId[]).filter(buildingId => {
          if (buildingId === "arms_industry") {
            // flat_bonus.cash helps any cash deficit; production% helps if city resource is in deficit
            return deficitResources.has("cash") || deficitResources.has(city.resource as Resource);
          }
          // air_base / naval_base only boost city's primary resource production
          return deficitResources.has(city.resource as Resource);
        });

        for (const buildingId of candidateBuildingIds) {
          const maxLevel = maxDefinedBuildingLevel(buildingId);
          const nextLevel = levels[buildingId] + 1;
          if (nextLevel > maxLevel) continue;
          if (buildingId === "relocate_headquarters" && city.capital) continue;

          const nextActions = [...state.actions, { cityId, buildingId, targetLevel: nextLevel }];
          const key = nextActions.map(action => `${action.cityId}:${action.buildingId}:${action.targetLevel}`).join("|");
          if (seen.has(key)) continue;
          seen.add(key);

          const ecoBuildOrder = nextActions.map(action => ({
            cityId: action.cityId,
            buildingId: action.buildingId,
            targetLevel: action.targetLevel,
          }));
          const simulation = simulateBuildOrder({
            cities: buildAllCityStates(),
            buildOrder: [...baseBuildOrder, ...ecoBuildOrder],
            buildings,
            scenario,
            hoursToSimulate: truceLengthDays * 24,
          });
          const affordability = buildAffordabilityResult({
            plan: option.plan,
            buildCosts: timedBuildRowsFromSimulation(simulation),
            hourlyIncome: dynamicHourlyIncomeFromSimulation(simulation),
            hoursToSimulate: truceLengthDays * 24,
          });
          const extraCost = zeroResources();
          for (const action of nextActions) {
            addResources(extraCost, buildingCost(buildings, action.buildingId, action.targetLevel));
          }

          nextBeam.push({
            actions: nextActions,
            affordability,
            extraCost,
            simulation,
          });
        }
      }
    }

    nextBeam.sort(compareBeamState);
    beam = nextBeam.slice(0, beamWidth);
    if ((depth + 1) % progressEveryEcoDepth === 0) {
      const bestAtDepth = beam[0];
      progress(
        `eco depth ${depth + 1}/${maxActions}: frontier=${beam.length} ` +
        `bestAffordable=${Boolean(bestAtDepth?.affordability.affordable)} ` +
        `bestDeficit=${Number(deficitScore(bestAtDepth?.affordability ?? option.affordability).toFixed(2))} ` +
        `actions=${bestAtDepth?.actions.length ?? 0}`
      );
    }
    if (beam[0]?.affordability.affordable) break;
  }

  const best = beam.slice().sort(compareBeamState)[0];
  if (!best) return null;
  progress(
    `eco support complete: affordable=${best.affordability.affordable} ` +
    `actions=${best.actions.length} extraCost=${Number(totalResourceCost(best.extraCost).toFixed(2))} ` +
    `remainingDeficit=${Number(deficitScore(best.affordability).toFixed(2))}`
  );

  const baseKeys = new Set(baseBuildOrder.map(action => `${action.cityId}:${action.buildingId}:${action.targetLevel}`));
  const timedRows = (best.simulation.timingDebug?.builds ?? [])
    .filter(build => !baseKeys.has(`${build.cityId}:${build.buildingId}:${build.toLevel}`))
    .map(build => ({
      cityId: build.cityId,
      buildingId: build.buildingId as EcoBuildingId,
      toLevel: build.toLevel,
      startDay: mapDayForAbsoluteHour(scenarioStartHour + build.startRelHour),
      startHour: hourOfDayForAbsoluteHour(scenarioStartHour + build.startRelHour),
      completionDay: mapDayForAbsoluteHour(build.completionAbs),
      completionHour: hourOfDayForAbsoluteHour(build.completionAbs),
    }));

  return {
    foundAffordablePath: best.affordability.affordable,
    actions: best.actions,
    timedRows,
    extraCost: best.extraCost,
    affordability: best.affordability,
  };
}

function compareOptions(a: EvaluatedOption, b: EvaluatedOption) {
  return (
    (Number(b.affordability.affordable) - Number(a.affordability.affordable)) ||
    (a.totalEconomicCost - b.totalEconomicCost) ||
    (totalResourceCost(a.infrastructureCost) - totalResourceCost(b.infrastructureCost)) ||
    (totalResourceCost(a.preWarUpkeep) - totalResourceCost(b.preWarUpkeep)) ||
    (a.totalCities - b.totalCities) ||
    (a.totalRecruitingOfficeLevels - b.totalRecruitingOfficeLevels) ||
    (a.totalArmsIndustryLevels - b.totalArmsIndustryLevels) ||
    (a.totalReadyHoursBeforeWar - b.totalReadyHoursBeforeWar) ||
    (a.latestResearchEndAbsoluteHour - b.latestResearchEndAbsoluteHour)
  );
}

const explicitScenarioId = process.env.PLAN_SCENARIO ?? "elite/antarctica";
const planFilePath = process.env.PLAN_FILE;
const planId = process.env.PLAN_ID;
const planFile =
  planId ? loadScenarioForcePlan(explicitScenarioId, planId) :
  planFilePath ? loadForcePlanFile(path.resolve(planFilePath)) :
  null;

const scenarioId = planFile?.scenario ?? explicitScenarioId;
const countryId = planFile?.country ?? process.env.PLAN_COUNTRY ?? "argentina";
const truceLengthDays = planFile?.truce_days ?? parsePositiveInt(process.env.PLAN_TRUCE_DAYS, 28);
const topN = planFile?.search?.top ?? parsePositiveInt(process.env.PLAN_TOP, 10);
const maxExtraCities = planFile?.search?.max_extra_cities ?? parseNonNegativeInt(process.env.PLAN_MAX_EXTRA_CITIES, 2);
const maxRecruitingOfficeLevel = Math.min(
  MAX_BUILDING_LEVEL,
  planFile?.search?.max_recruiting_office_level ?? parsePositiveInt(process.env.PLAN_MAX_RO_LEVEL, 5)
);
const maxArmsIndustryLevel = Math.min(
  MAX_BUILDING_LEVEL,
  planFile?.search?.max_arms_industry_level ?? parsePositiveInt(process.env.PLAN_MAX_AI_LEVEL, 1)
);

const parsedDemands = planFile?.demands ?? parseDemandList(process.env.PLAN_DEMANDS);
const demands: MobilizationDemand[] = parsedDemands ?? [];

if (demands.length === 0) {
  throw new Error("no demands configured; define them in the plan YAML or set PLAN_DEMANDS");
}

const scenario = {
  ...loadScenarioFile(scenarioId),
  truce_length_days: truceLengthDays,
};
const country = loadScenarioCountry(scenarioId, countryId);
const buildings = loadBuildingsFile();
const catalog = loadMergedUnitCatalogForScenario(scenarioId);
const scenarioStartHour = scenarioStartAbsoluteHour(scenario);
const deadlineAbsoluteHour = scenarioStartHour + (truceLengthDays * 24);
const baselineCountryTable = buildCountryHourlyResourceBalanceTable(
  country,
  truceLengthDays,
  scenario.speed,
  {
    buildingsFile: buildings,
    scenario,
    startingBalances: scenario.starting_balance,
    startAbsoluteHour: scenarioStartHour,
  }
);
const baselineCountryHourly = hourlyDeltasFromCountryTable(baselineCountryTable).slice(0, truceLengthDays * 24);
const baselineCitySimulation = simulateBuildOrder({
  cities: buildAllCityStates(),
  buildOrder: [],
  buildings,
  scenario,
  hoursToSimulate: truceLengthDays * 24,
});

function dynamicHourlyIncomeFromSimulation(simulation: ReturnType<typeof simulateBuildOrder>) {
  return simulation.perHourAggregate.map((row, index) => {
    const delta = zeroResources();
    const baselineCityProduction = baselineCitySimulation.perHourAggregate[index]?.production ?? zeroResources();
    for (const resource of RESOURCE_KEYS) {
      delta[resource] =
        (baselineCountryHourly[index]?.[resource] ?? 0) +
        row.production[resource] -
        baselineCityProduction[resource];
    }
    return delta;
  });
}

// Try to create a baseline plan with base cities, but if that fails,
// use more cities to establish the baseline requirements
let baselinePlan: MobilizationPlanResult;
try {
  baselinePlan = planMobilizationBuild({
    catalog,
    buildings,
    scenario,
    demands,
    maxCitiesPerQueue: country.cities.length,
  });
} catch (error) {
  // If baseline with base cities fails, try with max cities to get requirements
  const maxPossibleCities = Math.max(
    ...demands.map(demand => {
      const queueType = queueTypeForUnit(catalog, demand.unitId);
      return candidateCitiesForQueueType(country, queueType).length;
    })
  );
  baselinePlan = planMobilizationBuild({
    catalog,
    buildings,
    scenario,
    demands,
    maxCitiesPerQueue: maxPossibleCities,
  });
}

const baselineProfiles = baselinePlan.cityProfiles.map(profile => ({
  queueKey: profile.queueKey,
  queueType: profile.queueType,
  cityCount: profile.cityCount,
  requiredBaseLevel: profile.requiredBaseLevel,
  requiredArmyBaseLevel: profile.requiredArmyBaseLevel,
  requiredRecruitingOfficeLevel: profile.requiredRecruitingOfficeLevel,
  armsIndustryTargetLevel: 1,
  candidateCities: candidateCitiesForQueueType(country, profile.queueType).slice(0, profile.cityCount),
}));

const queueSearchSpace = baselineProfiles.map(profile => ({
  queueKey: profile.queueKey,
  queueType: profile.queueType,
  minRecruitingOfficeLevel: profile.requiredRecruitingOfficeLevel,
  maxCityCount: Math.min(
    candidateCitiesForQueueType(country, profile.queueType).length,
    profile.cityCount + maxExtraCities
  ),
  maxArmsIndustryLevel,
}));

const evaluatedOptions: EvaluatedOption[] = [];
const progressEnabled = process.env.PLAN_PROGRESS !== "false";
const progressEveryOptions = parsePositiveInt(process.env.PLAN_PROGRESS_EVERY_OPTIONS, 10);
const progressEveryEcoDepth = parsePositiveInt(process.env.PLAN_PROGRESS_EVERY_ECO_DEPTH, 1);
const totalChoiceCombinations = queueSearchSpace.reduce((product, group) => {
  const roChoices = Math.max(0, maxRecruitingOfficeLevel - group.minRecruitingOfficeLevel + 1);
  const aiChoices = group.maxArmsIndustryLevel;
  return product * Math.max(1, roChoices * group.maxCityCount * aiChoices);
}, 1);
let evaluatedChoiceCount = 0;

function progress(message: string) {
  if (!progressEnabled) return;
  console.error(`[force-plan] ${message}`);
}

function evaluateChoiceSet(choices: QueueChoice[]) {
  const choiceByQueue = new Map(choices.map(choice => [choice.queueKey, choice]));
  const forcedDemands = demands.map(demand => {
    const queueKey = queueKeyForDemand(catalog, demand);
    const choice = choiceByQueue.get(queueKey);
    if (!choice) return demand;
    return {
      ...demand,
      forcedCityCount: choice.cityCount,
      forcedRecruitingOfficeLevel: choice.recruitingOfficeLevel,
    };
  });

  let plan: MobilizationPlanResult;
  try {
    plan = planMobilizationBuild({
      catalog,
      buildings,
      scenario,
      demands: forcedDemands,
    });
  } catch {
    return;
  }

  const profileSummaries = plan.cityProfiles.map(profile => {
    const choice = choiceByQueue.get(profile.queueKey);
    return {
      queueKey: profile.queueKey,
      queueType: profile.queueType,
      cityCount: profile.cityCount,
      requiredBaseLevel: profile.requiredBaseLevel,
      requiredArmyBaseLevel: profile.requiredArmyBaseLevel,
      requiredRecruitingOfficeLevel: profile.requiredRecruitingOfficeLevel,
      armsIndustryTargetLevel: choice?.armsIndustryLevel ?? 1,
      candidateCities: candidateCitiesForQueueType(country, profile.queueType).slice(0, profile.cityCount),
    };
  });

  const infrastructure = planInfrastructureForProfiles(
    profileSummaries,
    plan,
    scenarioStartHour,
    truceLengthDays
  );
  const upkeep = preWarUpkeepForPlan(catalog, plan, deadlineAbsoluteHour);
  const mobilisationCost = zeroResources();
  for (const segment of plan.segments) {
    const segLevel = catalog.units[segment.unitId]?.levels[String(segment.mobilizeLevel)];
    const segCost = segLevel?.mobilisation[country.country.doctrine]?.cost;
    if (segCost) addResources(mobilisationCost, segCost);
  }
  const latestResearchEndAbsoluteHour = Math.max(
    scenarioStartHour,
    ...plan.researchPlan.segments.map(segment => segment.endAbsoluteHourExclusive)
  );
  const latestMobilizationEndAbsoluteHour = Math.max(
    scenarioStartHour,
    ...plan.segments.map(segment => segment.endAbsoluteHourExclusive)
  );
  const forcePlanBuildOrder = infrastructure.cityBuildPlans.flatMap(cityPlan => cityPlan.buildActions);
  const forcePlanSimulation = simulateBuildOrder({
    cities: buildAllCityStates(),
    buildOrder: forcePlanBuildOrder,
    buildings,
    scenario,
    hoursToSimulate: truceLengthDays * 24,
  });
  const buildCosts = timedBuildRowsFromSimulation(forcePlanSimulation);
  const affordability = buildAffordabilityResult({
    plan,
    buildCosts,
    hourlyIncome: dynamicHourlyIncomeFromSimulation(forcePlanSimulation),
    hoursToSimulate: truceLengthDays * 24,
  });

  const evaluated: EvaluatedOption = {
    choices,
    plan,
    profiles: profileSummaries,
    cityBuildPlans: infrastructure.cityBuildPlans,
    totalCities: plan.cityProfiles.reduce((sum, profile) => sum + profile.cityCount, 0),
    totalRecruitingOfficeLevels: plan.cityProfiles.reduce(
      (sum, profile) => sum + (profile.cityCount * profile.requiredRecruitingOfficeLevel),
      0
    ),
    totalArmsIndustryLevels: profileSummaries.reduce(
      (sum, profile) => sum + (profile.cityCount * profile.armsIndustryTargetLevel),
      0
    ),
    totalReadyHoursBeforeWar: upkeep.readyHours,
    infrastructureCost: infrastructure.totalCost,
    mobilisationCost,
    preWarUpkeep: upkeep.totals,
    latestResearchEndAbsoluteHour,
    latestMobilizationEndAbsoluteHour,
    totalEconomicCost: totalResourceCost(infrastructure.totalCost) + totalResourceCost(mobilisationCost) + totalResourceCost(upkeep.totals),
    affordability,
    ecoSupport: null,
  };
  evaluatedOptions.push(evaluated);
  evaluatedChoiceCount += 1;
  if (evaluatedChoiceCount % progressEveryOptions === 0) {
    progress(
      `force options ${evaluatedChoiceCount}/${totalChoiceCombinations}: ` +
      `${choices.map(choice => `${choice.queueType}:${choice.cityCount}@RO${choice.recruitingOfficeLevel}@AI${choice.armsIndustryLevel}`).join(" ; ")} ` +
      `=> affordable=${evaluated.affordability.affordable} totalCost=${Number(evaluated.totalEconomicCost.toFixed(2))}`
    );
  }
}

function searchChoices(index: number, current: QueueChoice[]) {
  if (index >= queueSearchSpace.length) {
    evaluateChoiceSet(current);
    return;
  }

  const group = queueSearchSpace[index];
  if (!group) return;

  for (let armsIndustryLevel = 1; armsIndustryLevel <= group.maxArmsIndustryLevel; armsIndustryLevel++) {
    for (let recruitingOfficeLevel = group.minRecruitingOfficeLevel; recruitingOfficeLevel <= maxRecruitingOfficeLevel; recruitingOfficeLevel++) {
      for (let cityCount = 1; cityCount <= group.maxCityCount; cityCount++) {
        searchChoices(index + 1, [
          ...current,
          {
            queueKey: group.queueKey,
            queueType: group.queueType,
            cityCount,
            recruitingOfficeLevel,
            armsIndustryLevel,
          },
        ]);
      }
    }
  }
}

progress(
  `starting force search: ${totalChoiceCombinations} queue combinations, ` +
  `${demands.map(demand => `${demand.unitId}:${demand.count}`).join(", ")}`
);
searchChoices(0, []);
evaluatedOptions.sort(compareOptions);
progress(`force search complete: ${evaluatedOptions.length} feasible option(s) evaluated`);

if (evaluatedOptions.length === 0) {
  throw new Error("no feasible force-planning options found in the searched city-count/RO space");
}

const best = evaluatedOptions[0];
progress(
  `chosen footprint: ${best.choices.map(choice => `${choice.queueType}:${choice.cityCount}@RO${choice.recruitingOfficeLevel}@AI${choice.armsIndustryLevel}`).join(" ; ")} ` +
  `baselineAffordable=${best.affordability.affordable} totalCost=${Number(best.totalEconomicCost.toFixed(2))}`
);
best.ecoSupport = ecoSupportSearch(best);

function printResearchPlan(plan: MobilizationPlanResult) {
  for (const slot of [1, 2] as const) {
    console.log(`Research slot ${slot}`);
    console.table(
      plan.researchPlan.segments
        .filter(segment => segment.slot === slot)
        .map(segment => ({
          unitId: segment.unitId,
          level: segment.level,
          startDay: mapDayForAbsoluteHour(segment.startAbsoluteHour),
          startHour: hourOfDayForAbsoluteHour(segment.startAbsoluteHour),
          endDay: mapDayForAbsoluteHour(segment.endAbsoluteHourExclusive),
          endHour: hourOfDayForAbsoluteHour(segment.endAbsoluteHourExclusive),
          durationHours: segment.durationHours,
        }))
    );
  }
}

function shortfallSummaryRows(affordability: AffordabilityResult) {
  return RESOURCE_KEYS
    .filter(resource =>
      affordability.minimumBalances[resource] < 0 ||
      affordability.cumulativeDeficitByResource[resource] > 0
    )
    .map(resource => ({
      resource,
      firstDeficitDay: affordability.firstDeficitByResource[resource]?.day ?? null,
      firstDeficitHour: affordability.firstDeficitByResource[resource]?.hour ?? null,
      firstDeficitBalance: affordability.firstDeficitByResource[resource]?.balance ?? null,
      minimumBalance: affordability.minimumBalances[resource],
      cumulativeDeficit: Number(affordability.cumulativeDeficitByResource[resource].toFixed(2)),
      endingBalance: Number(affordability.endingBalances[resource].toFixed(2)),
    }));
}

function resourceBalanceRows(affordability: AffordabilityResult) {
  return RESOURCE_KEYS.map(resource => ({
    resource,
    endingBalance: Number(affordability.endingBalances[resource].toFixed(2)),
    minimumBalance: Number(affordability.minimumBalances[resource].toFixed(2)),
    firstDeficitDay: affordability.firstDeficitByResource[resource]?.day ?? null,
    firstDeficitHour: affordability.firstDeficitByResource[resource]?.hour ?? null,
  }));
}

function cityMobilizationSummaryRows(plan: MobilizationPlanResult, queueKey: string, cityIndex: number): CityMobilizationSummaryRow[] {
  const groups = new Map<string, CityMobilizationSummaryRow>();
  for (const segment of plan.segments.filter(segment => segment.queueKey === queueKey && segment.cityIndex === cityIndex)) {
    const key = `${segment.unitId}:${segment.mobilizeLevel}`;
    const existing = groups.get(key);
    const row: CityMobilizationSummaryRow = existing ?? {
      unitId: segment.unitId,
      mobilizeLevel: segment.mobilizeLevel,
      count: 0,
      firstStartDay: mapDayForAbsoluteHour(segment.startAbsoluteHour),
      firstStartHour: hourOfDayForAbsoluteHour(segment.startAbsoluteHour),
      lastEndDay: mapDayForAbsoluteHour(segment.endAbsoluteHourExclusive),
      lastEndHour: hourOfDayForAbsoluteHour(segment.endAbsoluteHourExclusive),
    };
    row.count += 1;
    const startAbs = segment.startAbsoluteHour;
    const endAbs = segment.endAbsoluteHourExclusive;
    const existingFirstAbs = ((row.firstStartDay - 1) * 24) + row.firstStartHour;
    const existingLastAbs = ((row.lastEndDay - 1) * 24) + row.lastEndHour;
    if (startAbs < existingFirstAbs) {
      row.firstStartDay = mapDayForAbsoluteHour(startAbs);
      row.firstStartHour = hourOfDayForAbsoluteHour(startAbs);
    }
    if (endAbs > existingLastAbs) {
      row.lastEndDay = mapDayForAbsoluteHour(endAbs);
      row.lastEndHour = hourOfDayForAbsoluteHour(endAbs);
    }
    groups.set(key, row);
  }
  return Array.from(groups.values()).sort((a, b) =>
    a.unitId.localeCompare(b.unitId) ||
    a.mobilizeLevel - b.mobilizeLevel
  );
}

console.log("Force projection planner");
if (planFilePath) {
  console.log(`Plan file: ${path.resolve(planFilePath)}`);
  console.log(`Plan name: ${planFile?.name}`);
}
if (planId) {
  console.log(`Plan id: ${planId}`);
  console.log(`Plan name: ${planFile?.name}`);
}
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(`Country: ${country.country.name}`);
console.log(`Window before war: ${truceLengthDays} days`);
console.log("Demand:");
console.table(demands);
console.log(`Search space: ${evaluatedOptions.length} feasible option(s)`);
console.log("Ranking: affordable plans first, then lowest total cost (infrastructure + pre-war upkeep), then lower infra cost, then lower upkeep, then fewer cities/RO");

console.log("Top options");
console.table(
  evaluatedOptions.slice(0, topN).map((option, index) => ({
      rank: index + 1,
      queues: option.choices
        .map(choice => `${choice.queueType}:${choice.cityCount}@RO${choice.recruitingOfficeLevel}@AI${choice.armsIndustryLevel}`)
        .join(" ; "),
      affordable: option.affordability.affordable,
      totalCities: option.totalCities,
      totalROLevels: option.totalRecruitingOfficeLevels,
      totalAILevels: option.totalArmsIndustryLevels,
      readyHoursBeforeWar: option.totalReadyHoursBeforeWar,
      totalEconomicCost: Number(option.totalEconomicCost.toFixed(2)),
      infraCash: option.infrastructureCost.cash,
      infraElectronics: option.infrastructureCost.electronics,
      mobCash: option.mobilisationCost.cash,
      mobComponents: option.mobilisationCost.components,
    upkeepCash: Number(option.preWarUpkeep.cash.toFixed(2)),
    upkeepManpower: Number(option.preWarUpkeep.manpower.toFixed(2)),
    latestResearchDay: mapDayForAbsoluteHour(option.latestResearchEndAbsoluteHour),
    latestResearchHour: hourOfDayForAbsoluteHour(option.latestResearchEndAbsoluteHour),
    lastUnitReadyDay: mapDayForAbsoluteHour(option.latestMobilizationEndAbsoluteHour),
    lastUnitReadyHour: hourOfDayForAbsoluteHour(option.latestMobilizationEndAbsoluteHour),
  }))
);

console.log("Chosen footprint");
console.table(
  best.plan.cityProfiles.map(profile => ({
    queueType: profile.queueType,
    queueKey: profile.queueKey,
    cityCount: profile.cityCount,
    requiredBaseLevel: profile.requiredBaseLevel,
    requiredArmyBaseLevel: profile.requiredArmyBaseLevel,
    requiredRecruitingOfficeLevel: profile.requiredRecruitingOfficeLevel,
    perCityQueueHours: profile.perCityQueueHours.join(", "),
  }))
);

console.log("Pre-war upkeep exposure");
console.table([
  {
    supplies: Number(best.preWarUpkeep.supplies.toFixed(2)),
    components: Number(best.preWarUpkeep.components.toFixed(2)),
    fuel: Number(best.preWarUpkeep.fuel.toFixed(2)),
    rares: Number(best.preWarUpkeep.rares.toFixed(2)),
    electronics: Number(best.preWarUpkeep.electronics.toFixed(2)),
    cash: Number(best.preWarUpkeep.cash.toFixed(2)),
    manpower: Number(best.preWarUpkeep.manpower.toFixed(2)),
    readyHoursBeforeWar: best.totalReadyHoursBeforeWar,
    },
  ]);

if (best.affordability.affordable) {
  console.log("Affordability: affordable against baseline country income and starting balance");
} else {
  console.log("Affordability: NOT affordable against baseline country income and starting balance");
  console.table([best.affordability.firstDeficit]);
}

console.log("Minimum balances during plan");
console.table([best.affordability.minimumBalances]);
const baselineShortfallRows = shortfallSummaryRows(best.affordability);
const ecoShortfallRows = best.ecoSupport ? shortfallSummaryRows(best.ecoSupport.affordability) : [];
const outputMode = (process.env.PLAN_OUTPUT ?? "terminal").trim().toLowerCase();
const defaultPlanOutputFile = path.resolve("tmp/force-plan-output.html");
const outputFilePath = path.resolve(process.env.PLAN_OUTPUT_FILE?.trim() || defaultPlanOutputFile);

function markdownValue(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function printMarkdownTable(rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) {
    console.log("_None_");
    return;
  }

  const headers = Array.from(
    rows.reduce((set, row) => {
      for (const key of Object.keys(row)) set.add(key);
      return set;
    }, new Set<string>())
  );

  console.log(`| ${headers.join(" | ")} |`);
  console.log(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows) {
    console.log(`| ${headers.map(header => markdownValue(row[header])).join(" | ")} |`);
  }
}

function printMarkdownBulletList(lines: string[]) {
  if (lines.length === 0) {
    console.log("_None_");
    return;
  }
  for (const line of lines) {
    console.log(`- ${line}`);
  }
}

function printMarkdownResearchPlan(plan: MobilizationPlanResult) {
  console.log("## Research Plan");
  console.log("");
  for (const slot of [1, 2] as const) {
    console.log(`### Slot ${slot}`);
    printMarkdownTable(
      plan.researchPlan.segments
        .filter(segment => segment.slot === slot)
        .map(segment => ({
          unitId: segment.unitId,
          level: segment.level,
          startDay: mapDayForAbsoluteHour(segment.startAbsoluteHour),
          startHour: hourOfDayForAbsoluteHour(segment.startAbsoluteHour),
          endDay: mapDayForAbsoluteHour(segment.endAbsoluteHourExclusive),
          endHour: hourOfDayForAbsoluteHour(segment.endAbsoluteHourExclusive),
          durationHours: segment.durationHours,
        }))
    );
    console.log("");
  }
}

function printMarkdownOutput() {
  console.log("# Force Projection Plan");
  console.log("");

  const summaryRows = [{
    scenario: `${scenario.id} (${scenario.speed})`,
    country: country.country.name,
    windowDays: truceLengthDays,
    planId: planId ?? "",
    searchSpace: evaluatedOptions.length,
    affordableBaseline: best.affordability.affordable,
    affordableWithEcoSupport: best.ecoSupport?.foundAffordablePath ?? "",
  }];

  console.log("## Summary");
  console.log("");
  printMarkdownTable(summaryRows);
  console.log("");

  console.log("## Demand");
  console.log("");
  printMarkdownTable(demands.map(demand => ({
    unitId: demand.unitId,
    count: demand.count,
  })));
  console.log("");

  console.log("## Baseline Affordability");
  console.log("");
  if (best.affordability.affordable) {
    printMarkdownBulletList(["Affordable against starting balance plus baseline country income."]);
  } else {
    printMarkdownBulletList([
      "Not affordable against starting balance plus baseline country income.",
      `First deficit: day ${best.affordability.firstDeficit?.day}, hour ${best.affordability.firstDeficit?.hour}, ${best.affordability.firstDeficit?.resource} ${best.affordability.firstDeficit?.balance}`,
    ]);
  }
  console.log("");
  console.log("### Resource Balances");
  printMarkdownTable(resourceBalanceRows(best.affordability));
  console.log("");
  if (baselineShortfallRows.length > 0) {
    console.log("### Baseline Shortfall");
    printMarkdownTable(baselineShortfallRows);
    console.log("");
  }

  if (best.ecoSupport) {
    console.log("## Eco Support");
    console.log("");
    printMarkdownBulletList([
      best.ecoSupport.foundAffordablePath
        ? "Found an affordable eco-support path."
        : "No affordable eco-support path found in searched space.",
      `Added economic cost: ${Number(totalResourceCost(best.ecoSupport.extraCost).toFixed(2))}`,
      `Added actions: ${best.ecoSupport.actions.length}`,
    ]);
    console.log("");
    console.log("### Eco Support Timed Order");
    printMarkdownTable(best.ecoSupport.timedRows);
    console.log("");
    console.log("### Eco Support Minimum Balances");
    printMarkdownTable(resourceBalanceRows(best.ecoSupport.affordability));
    console.log("");
    if (ecoShortfallRows.length > 0) {
      console.log("### Eco Support Shortfall");
      printMarkdownTable(ecoShortfallRows);
      console.log("");
    }
  }

  printMarkdownResearchPlan(best.plan);

  console.log("## City Plans");
  console.log("");
  for (const buildPlan of best.cityBuildPlans) {
    console.log(`### ${buildPlan.city.name} (${buildPlan.queueType})`);
    console.log("#### Build");
    printMarkdownTable(
      buildPlan.timingRows.map(row => ({
        buildingId: row.buildingId,
        fromLevel: row.fromLevel,
        toLevel: row.toLevel,
        startDay: row.startDay,
        startHour: row.startHour,
        completionDay: row.completionDay,
        completionHour: row.completionHour,
        durationHours: Number(row.durationHours.toFixed(2)),
      }))
    );
    console.log("");
    console.log("#### Mobilisation");
    printMarkdownTable(cityMobilizationSummaryRows(best.plan, buildPlan.queueKey, buildPlan.cityIndex));
    console.log("");
  }
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function htmlTable(rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return "<p><em>None</em></p>";
  const headers = Array.from(
    rows.reduce((set, row) => {
      for (const key of Object.keys(row)) set.add(key);
      return set;
    }, new Set<string>())
  );
  const head = `<tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join("")}</tr>`;
  const body = rows.map(row =>
    `<tr>${headers.map(header => `<td>${escapeHtml(row[header]).replaceAll("\n", "<br>")}</td>`).join("")}</tr>`
  ).join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function htmlList(lines: string[]) {
  if (lines.length === 0) return "<p><em>None</em></p>";
  return `<ul>${lines.map(line => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`;
}

function renderHtmlOutput() {
  const parts: string[] = [];
  parts.push(`<h1>Force Projection Plan</h1>`);
  parts.push(`<h2>Summary</h2>`);
  parts.push(htmlTable([{
    scenario: `${scenario.id} (${scenario.speed})`,
    country: country.country.name,
    windowDays: truceLengthDays,
    planId: planId ?? "",
    searchSpace: evaluatedOptions.length,
    affordableBaseline: best.affordability.affordable,
    affordableWithEcoSupport: best.ecoSupport?.foundAffordablePath ?? "",
  }]));
  parts.push(`<h2>Demand</h2>`);
  parts.push(htmlTable(demands.map(demand => ({ unitId: demand.unitId, count: demand.count }))));
  parts.push(`<h2>Baseline Affordability</h2>`);
  parts.push(htmlList(best.affordability.affordable ? [
    "Affordable against starting balance plus baseline country income.",
  ] : [
    "Not affordable against starting balance plus baseline country income.",
    `First deficit: day ${best.affordability.firstDeficit?.day}, hour ${best.affordability.firstDeficit?.hour}, ${best.affordability.firstDeficit?.resource} ${best.affordability.firstDeficit?.balance}`,
  ]));
  parts.push(`<h3>Resource Balances</h3>`);
  parts.push(htmlTable(resourceBalanceRows(best.affordability)));
  if (baselineShortfallRows.length > 0) {
    parts.push(`<h3>Baseline Shortfall</h3>`);
    parts.push(htmlTable(baselineShortfallRows));
  }
  if (best.ecoSupport) {
    parts.push(`<h2>Eco Support</h2>`);
    parts.push(htmlList([
      best.ecoSupport.foundAffordablePath
        ? "Found an affordable eco-support path."
        : "No affordable eco-support path found in searched space.",
      `Added economic cost: ${Number(totalResourceCost(best.ecoSupport.extraCost).toFixed(2))}`,
      `Added actions: ${best.ecoSupport.actions.length}`,
    ]));
    parts.push(`<h3>Eco Support Timed Order</h3>`);
    parts.push(htmlTable(best.ecoSupport.timedRows));
    parts.push(`<h3>Eco Support Minimum Balances</h3>`);
    parts.push(htmlTable(resourceBalanceRows(best.ecoSupport.affordability)));
    if (ecoShortfallRows.length > 0) {
      parts.push(`<h3>Eco Support Shortfall</h3>`);
      parts.push(htmlTable(ecoShortfallRows));
    }
  }
  parts.push(`<h2>Research Plan</h2>`);
  for (const slot of [1, 2] as const) {
    parts.push(`<h3>Slot ${slot}</h3>`);
    parts.push(htmlTable(best.plan.researchPlan.segments.filter(segment => segment.slot === slot).map(segment => ({
      unitId: segment.unitId,
      level: segment.level,
      startDay: mapDayForAbsoluteHour(segment.startAbsoluteHour),
      startHour: hourOfDayForAbsoluteHour(segment.startAbsoluteHour),
      endDay: mapDayForAbsoluteHour(segment.endAbsoluteHourExclusive),
      endHour: hourOfDayForAbsoluteHour(segment.endAbsoluteHourExclusive),
      durationHours: segment.durationHours,
    }))));
  }
  parts.push(`<h2>City Plans</h2>`);
  for (const buildPlan of best.cityBuildPlans) {
    parts.push(`<h3>${escapeHtml(`${buildPlan.city.name} (${buildPlan.queueType})`)}</h3>`);
    parts.push(`<h4>Build</h4>`);
    parts.push(htmlTable(buildPlan.timingRows.map(row => ({
      buildingId: row.buildingId,
      fromLevel: row.fromLevel,
      toLevel: row.toLevel,
      startDay: row.startDay,
      startHour: row.startHour,
      completionDay: row.completionDay,
      completionHour: row.completionHour,
      durationHours: Number(row.durationHours.toFixed(2)),
    }))));
    parts.push(`<h4>Mobilisation</h4>`);
    parts.push(htmlTable(cityMobilizationSummaryRows(best.plan, buildPlan.queueKey, buildPlan.cityIndex)));
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Force Projection Plan</title><style>
body{font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.4;padding:24px;max-width:1400px;margin:0 auto}
table{border-collapse:collapse;width:100%;margin:12px 0 24px}
th,td{border:1px solid #d0d7de;padding:8px 10px;vertical-align:top;text-align:left}
th{background:#f6f8fa}
h1,h2,h3,h4{margin:20px 0 8px}
ul{margin:8px 0 20px}
</style></head><body>${parts.join("")}</body></html>`;
}

function writeHtmlArtifact() {
  const rendered = renderHtmlOutput();
  fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
  fs.writeFileSync(outputFilePath, rendered, "utf8");
  return outputFilePath;
}

const htmlArtifactPath = writeHtmlArtifact();

if (outputMode === "notion" || outputMode === "markdown" || outputMode === "md") {
  printMarkdownOutput();
  console.error(`[force-plan] html written to ${htmlArtifactPath}`);
} else {
  if (baselineShortfallRows.length > 0) {
    console.log("Baseline shortfall by resource");
    console.table(baselineShortfallRows);
  }

  if (best.ecoSupport) {
    if (best.ecoSupport.foundAffordablePath) {
      console.log("Eco support search: found an affordable eco-support path");
    } else {
      console.log("Eco support search: no affordable eco-support path found in searched space");
    }
    console.table([{
      extraEconomicCost: Number(totalResourceCost(best.ecoSupport.extraCost).toFixed(2)),
      addedActions: best.ecoSupport.actions.length,
      affordable: best.ecoSupport.foundAffordablePath,
    }]);
    console.log("Eco support timed order");
    console.table(best.ecoSupport.timedRows);
    console.log("Eco support minimum balances");
    console.table([best.ecoSupport.affordability.minimumBalances]);
    if (ecoShortfallRows.length > 0) {
      console.log("Eco support shortfall by resource");
      console.table(ecoShortfallRows);
    }
  }

  printResearchPlan(best.plan);

  for (const profile of best.profiles) {
    console.log(`${profile.queueType.toUpperCase()} recommended cities`);
    console.table(
      profile.candidateCities.map((city, index) => {
        const buildPlan = best.cityBuildPlans.find(candidate =>
          candidate.queueKey === profile.queueKey && candidate.cityIndex === index + 1
        );
        return {
          slot: index + 1,
          cityId: city.id,
          name: city.name,
          resource: city.resource,
          capital: city.capital,
          population: city.population,
          startingAirBase: city.starting.air_base,
          startingNavalBase: city.starting.naval_base,
          buildSteps: buildPlan?.buildSteps.join(" ; ") ?? "(none)",
          infraCash: buildPlan?.totalCost.cash ?? 0,
          infraElectronics: buildPlan?.totalCost.electronics ?? 0,
          firstMobilizeDay: buildPlan?.firstMobilizationStartAbsoluteHour !== null && buildPlan?.firstMobilizationStartAbsoluteHour !== undefined
            ? mapDayForAbsoluteHour(buildPlan.firstMobilizationStartAbsoluteHour)
            : null,
          firstMobilizeHour: buildPlan?.firstMobilizationStartAbsoluteHour !== null && buildPlan?.firstMobilizationStartAbsoluteHour !== undefined
            ? hourOfDayForAbsoluteHour(buildPlan.firstMobilizationStartAbsoluteHour)
            : null,
        };
      })
    );

    for (const buildPlan of best.cityBuildPlans.filter(candidate => candidate.queueKey === profile.queueKey)) {
      console.log(`${profile.queueType.toUpperCase()} build plan: ${buildPlan.city.name}`);
      console.table(buildPlan.timingRows);
    }
  }

  console.log("Mobilisation queue timeline");
  console.table(
    best.plan.segments.map(segment => ({
      queueType: segment.queueType,
      queueKey: segment.queueKey,
      cityIndex: segment.cityIndex,
      unitId: segment.unitId,
      mobilizeLevel: segment.mobilizeLevel,
      recruitingOfficeLevel: segment.recruitingOfficeLevel,
      startDay: mapDayForAbsoluteHour(segment.startAbsoluteHour),
      startHour: hourOfDayForAbsoluteHour(segment.startAbsoluteHour),
      endDay: mapDayForAbsoluteHour(segment.endAbsoluteHourExclusive),
      endHour: hourOfDayForAbsoluteHour(segment.endAbsoluteHourExclusive),
      durationHours: segment.durationHours,
    }))
  );
  console.error(`[force-plan] html written to ${htmlArtifactPath}`);
}
