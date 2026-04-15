import path from "node:path";

import type {
  Resource,
  StartingPopulation,
} from "../../core/constants.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import { buildProvinceCohortsFromCountry } from "../../engine/provinces/province-cohorts.js";
import {
  scheduleBuildSegments,
  type BuildingId,
  type TimelineCityState,
} from "../../engine/orchestration/build-order-timeline.js";
import {
  simulateBuildOrder,
  type BuildAction,
  type CityState,
} from "../../engine/simulation/build-order-sim.js";
import {
  simulateProvinceBuildOrder,
  type ProvinceBuildAction,
} from "../../engine/simulation/province-build-order-sim.js";
import { planMobilizationBuild } from "../../engine/simulation/unit-mobilization-plan.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadUnitCatalog } from "../../scenarios/io/load-unit-catalog.js";
import type { Country } from "../../schemas/country-schema.js";
import { buildFixedResearchPlan } from "./fixed-research-plan.js";
import {
  buildHomelandCityBuildOrderFromBaseline,
  buildHomelandProvinceBuildOrderFromBaseline,
  challengeHomelandEcoBaseline,
} from "./default-eco-baseline.js";

const RESOURCE_KEYS: Resource[] = [
  "supplies",
  "components",
  "fuel",
  "rares",
  "electronics",
  "cash",
  "manpower",
];

const scenarioId = "elite_ww3_2026";
const buildingsFile = loadBuildingsFile(path.resolve("data/buildings.yml"));
const scenario = loadScenarioFile(scenarioId);
const iraq = loadScenarioCountry(scenarioId, "iraq");

const supportCatalog = loadUnitCatalog(path.resolve("data/units/support_units.yaml"));
const infantryCatalog = loadUnitCatalog(path.resolve("data/units/infantry_units.yaml"));
const officerCatalog = loadUnitCatalog(path.resolve("data/units/officer_units.yaml"));

const mergedCatalog = {
  ...supportCatalog,
  units: {
    ...supportCatalog.units,
    ...infantryCatalog.units,
    ...officerCatalog.units,
  },
};

const demands = [
  { unitId: "multiple_rocket_launcher", count: 42, researchTargetLevel: 5, queueGroup: "mrl", forcedCityCount: 3 },
  { unitId: "mobile_anti_air_vehicle", count: 45, researchTargetLevel: 6, queueGroup: "maav", forcedCityCount: 2 },
  { unitId: "special_forces", count: 20, researchTargetLevel: 5, queueGroup: "sf", forcedCityCount: 1 },
  { unitId: "uncommon_infantry_officer", count: 1, researchTargetLevel: 7, queueGroup: "maav", forcedCityCount: 2 },
];

const hoursToSimulate = 28 * 24;
const simulationStartAbsoluteHour = scenarioStartAbsoluteHour(scenario);

function zeroAmounts(): Record<Resource, number> {
  return {
    supplies: 0,
    components: 0,
    fuel: 0,
    rares: 0,
    electronics: 0,
    cash: 0,
    manpower: 0,
  };
}

function mapDayForAbsoluteHour(absoluteHour: number) {
  return Math.floor(absoluteHour / 24) + 1;
}

function hourOfDayForAbsoluteHour(absoluteHour: number) {
  return (absoluteHour % 24) + 1;
}

function levelData(buildingId: BuildingId, toLevel: number) {
  const level = buildingsFile.buildings[buildingId]?.levels[String(toLevel) as "1" | "2" | "3" | "4" | "5"];
  if (!level) {
    throw new Error(`Missing level data for ${buildingId} level ${toLevel}`);
  }
  return level;
}

function toCityStates(country: Country): CityState[] {
  return country.cities.map(city => ({
    cityId: `${country.country.id}:${city.id}`,
    countryId: country.country.id,
    capital: city.capital,
    resource: city.resource,
    startPop: city.population as StartingPopulation,
    cityStatus: "homeland",
    buildings: {
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
  }));
}

function toTimelineCityStates(cities: CityState[]): TimelineCityState[] {
  return cities.map(city => ({
    cityId: city.cityId,
    countryId: city.countryId,
    capital: city.capital,
    cityStatus: city.cityStatus,
    moraleParams: city.moraleParams,
    buildings: city.buildings,
  }));
}

function toTimelineProvinceStates(
  provinces: ReturnType<typeof buildProvinceCohortsFromCountry>
): TimelineCityState[] {
  return provinces.map(province => ({
    cityId: province.provinceId,
    countryId: province.countryId,
    cityStatus: province.cityStatus,
    moraleParams: province.moraleParams,
    buildings: {
      air_base: 0,
      annex_city: 0,
      arms_industry: 0,
      combat_outpost: province.buildings.combat_outpost ?? 0,
      local_industry: province.buildings.local_industry ?? 0,
      naval_base: 0,
      recruiting_office: 0,
      relocate_headquarters: 0,
      underground_bunkers: 0,
    },
  }));
}

function hourlyNetAdjustments(args: {
  hoursToSimulate: number;
  segmentsByEntity: ReturnType<typeof scheduleBuildSegments>;
}) {
  const adjustments = Array.from({ length: args.hoursToSimulate }, () => zeroAmounts());

  for (const buildingSegments of args.segmentsByEntity.values()) {
    for (const [buildingId, segments] of Object.entries(buildingSegments) as Array<[BuildingId, typeof buildingSegments[BuildingId]]>) {
      for (const segment of segments) {
        const startHourIndex = Math.floor(segment.startMinute / 60) - simulationStartAbsoluteHour;
        if (startHourIndex >= 0 && startHourIndex < args.hoursToSimulate) {
          const cost = levelData(buildingId, segment.toLevel).cost;
          for (const resource of RESOURCE_KEYS) {
            adjustments[startHourIndex][resource] -= cost[resource];
          }
        }

        const upkeep = levelData(buildingId, segment.toLevel).daily_upkeep;
        if (!upkeep) continue;

        const completionHourIndex = Math.ceil(segment.endMinute / 60) - simulationStartAbsoluteHour;
        for (let hourIndex = completionHourIndex; hourIndex < args.hoursToSimulate; hourIndex++) {
          for (const resource of RESOURCE_KEYS) {
            const amount = upkeep[resource];
            if (!Number.isFinite(amount ?? NaN)) continue;
            adjustments[hourIndex][resource] -= Math.floor((amount ?? 0) / 24);
          }
        }
      }
    }
  }

  return adjustments;
}

function unitLevel(unitId: string, level: number) {
  const data = mergedCatalog.units[unitId]?.levels[String(level)];
  if (!data) {
    throw new Error(`Missing unit data for ${unitId} level ${level}`);
  }
  return data;
}

function effectiveMobilizeLevelForSegment(
  researchSegments: ReturnType<typeof buildFixedResearchPlan>["segments"],
  unitId: string,
  plannedLevel: number,
  startAbsoluteHour: number
) {
  const completedLevels = researchSegments
    .filter(segment => segment.unitId === unitId && segment.endAbsoluteHourExclusive <= startAbsoluteHour)
    .map(segment => segment.level);

  return Math.max(plannedLevel, completedLevels.length === 0 ? plannedLevel : Math.max(...completedLevels));
}

function hourlyUnitAdjustments() {
  const adjustments = Array.from({ length: hoursToSimulate }, () => zeroAmounts());
  const mobilizationPlan = planMobilizationBuild({
    catalog: mergedCatalog,
    buildings: buildingsFile,
    scenario,
    demands,
  });
  const firstMobilizationStartByUnit = Object.fromEntries(
    Array.from(new Set(mobilizationPlan.segments.map(segment => segment.unitId))).map(unitId => [
      unitId,
      Math.min(
        ...mobilizationPlan.segments
          .filter(segment => segment.unitId === unitId)
          .map(segment => segment.startAbsoluteHour)
      ),
    ])
  ) as Record<string, number>;
  const researchPlan = buildFixedResearchPlan({
    catalog: mergedCatalog,
    scenario,
    lanes: [
      [
        { unitId: "uncommon_infantry_officer", targetLevel: 1 },
        { unitId: "mobile_anti_air_vehicle", targetLevel: 1 },
        { unitId: "uncommon_infantry_officer", targetLevel: 2 },
        { unitId: "uncommon_infantry_officer", targetLevel: 3 },
        { unitId: "uncommon_infantry_officer", targetLevel: 4 },
        { unitId: "uncommon_infantry_officer", targetLevel: 5 },
        { unitId: "uncommon_infantry_officer", targetLevel: 6 },
        { unitId: "uncommon_infantry_officer", targetLevel: 7 },
        { unitId: "mobile_anti_air_vehicle", targetLevel: 2 },
        { unitId: "mobile_anti_air_vehicle", targetLevel: 3 },
        { unitId: "mobile_anti_air_vehicle", targetLevel: 4 },
        { unitId: "mobile_anti_air_vehicle", targetLevel: 5 },
        { unitId: "mobile_anti_air_vehicle", targetLevel: 6 },
      ],
      [
        { unitId: "special_forces", targetLevel: 1 },
        { unitId: "multiple_rocket_launcher", targetLevel: 1 },
        { unitId: "special_forces", targetLevel: 2 },
        { unitId: "multiple_rocket_launcher", targetLevel: 2 },
        { unitId: "special_forces", targetLevel: 3 },
        { unitId: "multiple_rocket_launcher", targetLevel: 3 },
        { unitId: "special_forces", targetLevel: 4 },
        { unitId: "multiple_rocket_launcher", targetLevel: 4 },
        { unitId: "special_forces", targetLevel: 5 },
        { unitId: "multiple_rocket_launcher", targetLevel: 5 },
      ],
    ],
    latestEndByAction: {
      "mobile_anti_air_vehicle@1": firstMobilizationStartByUnit.mobile_anti_air_vehicle,
      "special_forces@1": firstMobilizationStartByUnit.special_forces,
      "multiple_rocket_launcher@1": firstMobilizationStartByUnit.multiple_rocket_launcher,
    },
  });

  for (const spend of researchPlan.spendingByAbsoluteHour) {
    const hourIndex = spend.absoluteHour - simulationStartAbsoluteHour;
    if (hourIndex < 0 || hourIndex >= hoursToSimulate) continue;
    for (const resource of RESOURCE_KEYS) {
      adjustments[hourIndex][resource] -= spend.cost[resource];
    }
  }

  for (const segment of mobilizationPlan.segments) {
    const effectiveLevel = effectiveMobilizeLevelForSegment(
      researchPlan.segments,
      segment.unitId,
      segment.mobilizeLevel,
      segment.startAbsoluteHour
    );
    const level = unitLevel(segment.unitId, effectiveLevel);
    const startHourIndex = segment.startAbsoluteHour - simulationStartAbsoluteHour;
    if (startHourIndex >= 0 && startHourIndex < hoursToSimulate) {
      for (const resource of RESOURCE_KEYS) {
        adjustments[startHourIndex][resource] -= level.mobilisation.cost[resource];
      }
    }

    const completionHourIndex = segment.endAbsoluteHourExclusive - simulationStartAbsoluteHour;
    for (let hourIndex = Math.max(0, completionHourIndex); hourIndex < hoursToSimulate; hourIndex++) {
      for (const resource of RESOURCE_KEYS) {
        adjustments[hourIndex][resource] -= Math.floor(level.daily_upkeep.cost[resource] / 24);
      }
    }
  }

  return { adjustments, mobilizationPlan, researchPlan };
}

const iraqCities = toCityStates(iraq);
const iraqCityBuildOrder = buildHomelandCityBuildOrderFromBaseline(iraq, challengeHomelandEcoBaseline);
const iraqForceCityBuildOrder = [
  ...iraqCityBuildOrder,
  { cityId: "iraq:mosul", buildingId: "recruiting_office" as const, targetLevel: 3 },
  { cityId: "iraq:mosul", buildingId: "army_base" as const, targetLevel: 4 },
  { cityId: "iraq:karbala", buildingId: "air_base" as const, targetLevel: 1 },
  { cityId: "iraq:karbala", buildingId: "recruiting_office" as const, targetLevel: 3 },
  { cityId: "iraq:karbala", buildingId: "army_base" as const, targetLevel: 4 },
  { cityId: "iraq:qa'im", buildingId: "recruiting_office" as const, targetLevel: 3 },
  { cityId: "iraq:qa'im", buildingId: "army_base" as const, targetLevel: 4 },
  { cityId: "iraq:baghdad", buildingId: "army_base" as const, targetLevel: 3 },
  { cityId: "iraq:baghdad", buildingId: "recruiting_office" as const, targetLevel: 3 },
];
const iraqProvinceCohorts = buildProvinceCohortsFromCountry(iraq);
const iraqProvinceBuildOrder = buildHomelandProvinceBuildOrderFromBaseline(iraq, challengeHomelandEcoBaseline);

const iraqCitySim = simulateBuildOrder({
  cities: iraqCities,
  buildOrder: iraqForceCityBuildOrder,
  buildings: buildingsFile,
  scenario,
  hoursToSimulate,
});
const iraqProvinceSim = simulateProvinceBuildOrder({
  provinces: iraqProvinceCohorts,
  buildOrder: iraqProvinceBuildOrder,
  buildings: buildingsFile,
  scenario,
  hoursToSimulate,
});

const iraqCitySegments = scheduleBuildSegments({
  cities: toTimelineCityStates(iraqCities),
  buildOrder: iraqForceCityBuildOrder,
  buildings: buildingsFile,
  scenario,
});
const iraqProvinceSegments = scheduleBuildSegments({
  cities: toTimelineProvinceStates(iraqProvinceCohorts),
  buildOrder: iraqProvinceBuildOrder.map(action => ({
    cityId: action.provinceId,
    buildingId: action.buildingId,
    targetLevel: action.targetLevel,
  })),
  buildings: buildingsFile,
  scenario,
});

const iraqCityCostAdjustments = hourlyNetAdjustments({
  hoursToSimulate,
  segmentsByEntity: iraqCitySegments,
});
const iraqProvinceCostAdjustments = hourlyNetAdjustments({
  hoursToSimulate,
  segmentsByEntity: iraqProvinceSegments,
});
const { adjustments: unitAdjustments, mobilizationPlan, researchPlan } = hourlyUnitAdjustments();

const hourlyRows = Array.from({ length: hoursToSimulate }, (_, index) => {
  const absoluteHour = simulationStartAbsoluteHour + index;
  const income = zeroAmounts();
  const expenditure = zeroAmounts();
  const net = zeroAmounts();

  for (const resource of RESOURCE_KEYS) {
    income[resource] += iraqCitySim.perHourAggregate[index]?.production[resource] ?? 0;
    income[resource] += iraqProvinceSim.perHourAggregate[index]?.production[resource] ?? 0;

    const citySpend = iraqCityCostAdjustments[index]?.[resource] ?? 0;
    const provinceSpend = iraqProvinceCostAdjustments[index]?.[resource] ?? 0;
    const unitSpend = unitAdjustments[index]?.[resource] ?? 0;

    expenditure[resource] += Math.max(0, -citySpend);
    expenditure[resource] += Math.max(0, -provinceSpend);
    expenditure[resource] += Math.max(0, -unitSpend);

    net[resource] = income[resource] - expenditure[resource];
  }

  return {
    absoluteHour,
    mapDay: mapDayForAbsoluteHour(absoluteHour),
    hourOfDay: hourOfDayForAbsoluteHour(absoluteHour),
    income,
    expenditure,
    net,
  };
});

const startingBalances = scenario.starting_balance;
const rollingRows = hourlyRows.reduce<Array<{
  absoluteHour: number;
  mapDay: number;
  hourOfDay: number;
  balances: Record<Resource, number>;
}>>((rows, row) => {
  const previous = rows.at(-1)?.balances ?? startingBalances;
  const balances = zeroAmounts();
  for (const resource of RESOURCE_KEYS) {
    balances[resource] = previous[resource] + row.net[resource];
  }
  rows.push({
    absoluteHour: row.absoluteHour,
    mapDay: row.mapDay,
    hourOfDay: row.hourOfDay,
    balances,
  });
  return rows;
}, []);

const minima = Object.fromEntries(
  RESOURCE_KEYS.map(resource => {
    const minRow = rollingRows.reduce((best, row) => (
      row.balances[resource] < best.balances[resource] ? row : best
    ), rollingRows[0]!);
    return [resource, {
      value: minRow.balances[resource],
      absoluteHour: minRow.absoluteHour,
      mapDay: minRow.mapDay,
      hourOfDay: minRow.hourOfDay,
    }];
  })
) as Record<Resource, { value: number; absoluteHour: number; mapDay: number; hourOfDay: number }>;

const firstFailure = rollingRows.find(row => RESOURCE_KEYS.some(resource => row.balances[resource] < 0));
const moraleRange = mobilizationPlan.segments.reduce(
  (acc, segment) => ({
    min: Math.min(acc.min, segment.moralePct),
    max: Math.max(acc.max, segment.moralePct),
  }),
  { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY }
);

const dailyBalances = Array.from({ length: 29 }, (_, index) => {
  const mapDay = scenario.start.day + index;
  const endOfDay = rollingRows.filter(row => row.mapDay === mapDay).at(-1);
  return {
    mapDay,
    hoursCounted: rollingRows.filter(row => row.mapDay === mapDay).length,
    supplies: endOfDay?.balances.supplies ?? (mapDay < scenario.start.day ? startingBalances.supplies : 0),
    components: endOfDay?.balances.components ?? (mapDay < scenario.start.day ? startingBalances.components : 0),
    fuel: endOfDay?.balances.fuel ?? (mapDay < scenario.start.day ? startingBalances.fuel : 0),
    rares: endOfDay?.balances.rares ?? (mapDay < scenario.start.day ? startingBalances.rares : 0),
    electronics: endOfDay?.balances.electronics ?? (mapDay < scenario.start.day ? startingBalances.electronics : 0),
    cash: endOfDay?.balances.cash ?? (mapDay < scenario.start.day ? startingBalances.cash : 0),
    manpower: endOfDay?.balances.manpower ?? (mapDay < scenario.start.day ? startingBalances.manpower : 0),
  };
});

console.log("Elite WW3 Iraq economy smoke");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log("Assumptions:");
console.log("- Iraq only: homeland income, homeland infrastructure, Iraq-assigned research, mobilisation, unit upkeep");
console.log(`- homeland city and province economy follows the ${challengeHomelandEcoBaseline.name} baseline`);
console.log("- land mobilisation cities: mosul, karbala, qa'im to recruiting_office 3 first, then army_base 4");
console.log("- special forces air city: baghdad to army_base 3 and recruiting_office 3, with the infantry officer folded into the MAAV land queues");
console.log("- includes morale-adjusted mobilisation durations from the planner");
console.log("- unit mobilisation cost/upkeep use the highest researched level completed by the unit's mobilisation start");
console.log("- fixed research lanes: slot 1 = officer 1, MAAV 1, then full officer line before MAAV 2-6; slot 2 = SF1/MRL1/SF2/MRL2/.../SF5/MRL5, with level 1 anchored before queue starts");
console.log("Demand package:", demands);
console.log("Derived city footprint:");
console.table(mobilizationPlan.cityProfiles);
for (const slot of [1, 2] as const) {
  console.log(`Research slot ${slot}`);
  console.table(
    researchPlan.segments
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
console.log("Mobilisation morale range:");
console.table([{
  minMoralePct: Number.isFinite(moraleRange.min) ? moraleRange.min : null,
  maxMoralePct: Number.isFinite(moraleRange.max) ? moraleRange.max : null,
}]);
console.log("Minimum balances:");
console.table(Object.entries(minima).map(([resource, minimum]) => ({
  resource,
  minBalance: minimum.value,
  mapDay: minimum.mapDay,
  hourOfDay: minimum.hourOfDay,
  absoluteHour: minimum.absoluteHour,
})));

if (firstFailure) {
  console.log("First failing hour:");
  console.table([{
    mapDay: firstFailure.mapDay,
    hourOfDay: firstFailure.hourOfDay,
    absoluteHour: firstFailure.absoluteHour,
    ...firstFailure.balances,
  }]);
} else {
  console.log("No negative balances detected in the 28-day window.");
}

console.log("End-of-day rolling balances:");
console.table([
  {
    mapDay: "START",
    hoursCounted: "",
    ...startingBalances,
  },
  ...dailyBalances,
]);
