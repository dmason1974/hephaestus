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
import {
  buildHomelandCityBuildOrderFromBaseline,
  buildHomelandProvinceBuildOrderFromBaseline,
  challengeHomelandEcoBaseline,
} from "./default-eco-baseline.js";
import { buildFixedResearchPlan } from "./fixed-research-plan.js";

const RESOURCE_KEYS: Resource[] = [
  "supplies",
  "components",
  "fuel",
  "rares",
  "electronics",
  "cash",
  "manpower",
];

const scenarioId = "elite/ww3";
const buildingsFile = loadBuildingsFile(path.resolve("data/buildings.yml"));
const scenario = loadScenarioFile(scenarioId);
const turkey = loadScenarioCountry(scenarioId, "turkey");

const navalCatalog = loadUnitCatalog(path.resolve("data/units/naval_units.yml"));
const fighterCatalog = loadUnitCatalog(path.resolve("data/units/fighter_units.yml"));
const heaviesCatalog = loadUnitCatalog(path.resolve("data/units/heavies_units.yml"));
const infantryCatalog = loadUnitCatalog(path.resolve("data/units/infantry_units.yml"));
const officerCatalog = loadUnitCatalog(path.resolve("data/units/officer_units.yml"));
const seasonalCatalog = loadUnitCatalog(path.resolve("data/units/seasonal_units.yml"));

const mergedCatalog = {
  ...navalCatalog,
  units: {
    ...navalCatalog.units,
    ...fighterCatalog.units,
    ...heaviesCatalog.units,
    ...infantryCatalog.units,
    ...officerCatalog.units,
    ...seasonalCatalog.units,
  },
};

const demands = [
  { unitId: "fixed_wing_veteran", count: 1, researchTargetLevel: 6, queueGroup: "istanbul_air", forcedCityCount: 1 },
  { unitId: "epic_airstrike_officer", count: 1, researchTargetLevel: 6, queueGroup: "istanbul_air", forcedCityCount: 1 },
  { unitId: "awacs", count: 2, researchTargetLevel: 6, queueGroup: "istanbul_air", forcedCityCount: 1 },
  { unitId: "air_superiority_fighter", count: 9, queueGroup: "istanbul_air", forcedCityCount: 1 },
  { unitId: "airborne_infantry", count: 20, queueGroup: "ankara_airmobile", forcedCityCount: 1 },
  { unitId: "naval_veteran", count: 1, queueGroup: "antalya_eff", forcedCityCount: 1 },
  { unitId: "elite_frigate", count: 9, queueGroup: "antalya_eff", forcedCityCount: 1 },
  { unitId: "elite_drone_mothership", count: 10, queueGroup: "izmir_dms", forcedCityCount: 1 },
];

const queueCityNames: Record<string, string[]> = {
  "air:istanbul_air": ["istanbul"],
  "air:ankara_airmobile": ["ankara"],
  "naval:antalya_eff": ["antalya"],
  "naval:izmir_dms": ["izmir"],
};

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
  researchSegments: ReturnType<typeof planMobilizationBuild>["researchPlan"]["segments"],
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
    doctrine: turkey.country.doctrine,
    lanes: [
      [
        { unitId: "fixed_wing_veteran", targetLevel: 1 },
        { unitId: "fixed_wing_veteran", targetLevel: 2 },
        { unitId: "fixed_wing_veteran", targetLevel: 3 },
        { unitId: "fixed_wing_veteran", targetLevel: 4 },
        { unitId: "fixed_wing_veteran", targetLevel: 5 },
        { unitId: "fixed_wing_veteran", targetLevel: 6 },
        { unitId: "frigate", targetLevel: 1 },
        { unitId: "frigate", targetLevel: 2 },
        { unitId: "frigate", targetLevel: 3 },
        { unitId: "frigate", targetLevel: 4 },
        { unitId: "airborne_infantry", targetLevel: 1 },
        { unitId: "air_superiority_fighter", targetLevel: 1 },
        { unitId: "elite_drone_mothership", targetLevel: 1 },
        { unitId: "elite_drone_mothership", targetLevel: 2 },
        { unitId: "air_superiority_fighter", targetLevel: 2 },
        { unitId: "air_superiority_fighter", targetLevel: 3 },
        { unitId: "air_superiority_fighter", targetLevel: 4 },
        { unitId: "air_superiority_fighter", targetLevel: 5 },
        { unitId: "air_superiority_fighter", targetLevel: 6 },
        { unitId: "air_superiority_fighter", targetLevel: 7 },
      ],
      [
        { unitId: "epic_airstrike_officer", targetLevel: 1 },
        { unitId: "epic_airstrike_officer", targetLevel: 2 },
        { unitId: "epic_airstrike_officer", targetLevel: 3 },
        { unitId: "epic_airstrike_officer", targetLevel: 4 },
        { unitId: "epic_airstrike_officer", targetLevel: 5 },
        { unitId: "epic_airstrike_officer", targetLevel: 6 },
        { unitId: "naval_veteran", targetLevel: 1 },
        { unitId: "naval_veteran", targetLevel: 2 },
        { unitId: "naval_veteran", targetLevel: 3 },
        { unitId: "naval_veteran", targetLevel: 4 },
        { unitId: "naval_veteran", targetLevel: 5 },
        { unitId: "naval_veteran", targetLevel: 6 },
        { unitId: "naval_veteran", targetLevel: 7 },
        { unitId: "awacs", targetLevel: 1 },
        { unitId: "awacs", targetLevel: 2 },
        { unitId: "awacs", targetLevel: 3 },
        { unitId: "awacs", targetLevel: 4 },
        { unitId: "awacs", targetLevel: 5 },
        { unitId: "awacs", targetLevel: 6 },
      ],
    ],
    latestEndByAction: {
      "airborne_infantry@1": firstMobilizationStartByUnit.airborne_infantry,
      "air_superiority_fighter@1": firstMobilizationStartByUnit.air_superiority_fighter,
      "awacs@1": firstMobilizationStartByUnit.awacs,
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

const turkeyCities = toCityStates(turkey);
const turkeyCityBuildOrder = buildHomelandCityBuildOrderFromBaseline(turkey, challengeHomelandEcoBaseline);
const turkeyForceCityBuildOrder = [
  ...turkeyCityBuildOrder,
  { cityId: "turkey:ankara", buildingId: "recruiting_office" as const, targetLevel: 3 },
  { cityId: "turkey:istanbul", buildingId: "recruiting_office" as const, targetLevel: 3 },
  { cityId: "turkey:antalya", buildingId: "recruiting_office" as const, targetLevel: 3 },
  { cityId: "turkey:izmir", buildingId: "recruiting_office" as const, targetLevel: 3 },
  { cityId: "turkey:ankara", buildingId: "army_base" as const, targetLevel: 1 },
  { cityId: "turkey:ankara", buildingId: "air_base" as const, targetLevel: 2 },
  { cityId: "turkey:istanbul", buildingId: "air_base" as const, targetLevel: 4 },
  { cityId: "turkey:antalya", buildingId: "naval_base" as const, targetLevel: 4 },
  { cityId: "turkey:izmir", buildingId: "naval_base" as const, targetLevel: 2 },
];
const turkeyProvinceCohorts = buildProvinceCohortsFromCountry(turkey);
const turkeyProvinceBuildOrder = buildHomelandProvinceBuildOrderFromBaseline(turkey, challengeHomelandEcoBaseline);

const turkeyCitySim = simulateBuildOrder({
  cities: turkeyCities,
  buildOrder: turkeyForceCityBuildOrder,
  buildings: buildingsFile,
  scenario,
  hoursToSimulate,
});
const turkeyProvinceSim = simulateProvinceBuildOrder({
  provinces: turkeyProvinceCohorts,
  buildOrder: turkeyProvinceBuildOrder,
  buildings: buildingsFile,
  scenario,
  hoursToSimulate,
});

const turkeyCitySegments = scheduleBuildSegments({
  cities: toTimelineCityStates(turkeyCities),
  buildOrder: turkeyForceCityBuildOrder,
  buildings: buildingsFile,
  scenario,
});
const turkeyProvinceSegments = scheduleBuildSegments({
  cities: toTimelineProvinceStates(turkeyProvinceCohorts),
  buildOrder: turkeyProvinceBuildOrder.map(action => ({
    cityId: action.provinceId,
    buildingId: action.buildingId,
    targetLevel: action.targetLevel,
  })),
  buildings: buildingsFile,
  scenario,
});

const turkeyCityCostAdjustments = hourlyNetAdjustments({
  hoursToSimulate,
  segmentsByEntity: turkeyCitySegments,
});
const turkeyProvinceCostAdjustments = hourlyNetAdjustments({
  hoursToSimulate,
  segmentsByEntity: turkeyProvinceSegments,
});
const { adjustments: unitAdjustments, mobilizationPlan, researchPlan } = hourlyUnitAdjustments();

const hourlyRows = Array.from({ length: hoursToSimulate }, (_, index) => {
  const absoluteHour = simulationStartAbsoluteHour + index;
  const income = zeroAmounts();
  const expenditure = zeroAmounts();
  const net = zeroAmounts();

  for (const resource of RESOURCE_KEYS) {
    income[resource] += turkeyCitySim.perHourAggregate[index]?.production[resource] ?? 0;
    income[resource] += turkeyProvinceSim.perHourAggregate[index]?.production[resource] ?? 0;

    const turkeyCitySpend = turkeyCityCostAdjustments[index]?.[resource] ?? 0;
    const turkeyProvinceSpend = turkeyProvinceCostAdjustments[index]?.[resource] ?? 0;
    const unitSpend = unitAdjustments[index]?.[resource] ?? 0;

    expenditure[resource] += Math.max(0, -turkeyCitySpend);
    expenditure[resource] += Math.max(0, -turkeyProvinceSpend);
    expenditure[resource] += Math.max(0, -unitSpend);

    net[resource] += income[resource] - expenditure[resource];
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

const dailyTotals = Array.from({ length: 29 }, (_, index) => {
  const mapDay = scenario.start.day + index;
  const dayRows = hourlyRows.filter(row => row.mapDay === mapDay);
  const income = dayRows.reduce((acc, row) => {
    for (const resource of RESOURCE_KEYS) acc[resource] += row.income[resource];
    return acc;
  }, zeroAmounts());
  const expenditure = dayRows.reduce((acc, row) => {
    for (const resource of RESOURCE_KEYS) acc[resource] += row.expenditure[resource];
    return acc;
  }, zeroAmounts());
  const net = dayRows.reduce((acc, row) => {
    for (const resource of RESOURCE_KEYS) acc[resource] += row.net[resource];
    return acc;
  }, zeroAmounts());
  const endOfDay = rollingRows.filter(row => row.mapDay === mapDay).at(-1);

  return {
    mapDay,
    hoursCounted: dayRows.length,
    income,
    expenditure,
    net,
    balances: endOfDay?.balances ?? (mapDay < scenario.start.day ? startingBalances : zeroAmounts()),
  };
});

console.log("Elite WW3 Turkey economy smoke");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log("Assumptions:");
console.log("- Turkey homeland only: homeland income, homeland infrastructure, Turkey-assigned research, mobilisation, unit upkeep");
console.log(`- homeland city and province economy follows the ${challengeHomelandEcoBaseline.name} baseline`);
console.log("- air layout: istanbul -> ASF/AWACS/officers, ankara -> airborne");
console.log("- naval layout: antalya -> naval_veteran + elite_frigate, izmir -> elite_drone_mothership");
console.log("- upgrades turkey:ankara, turkey:istanbul, turkey:antalya, and turkey:izmir to recruiting_office 3");
console.log("- upgrades turkey:ankara to army_base 1 and air_base 2");
console.log("- upgrades turkey:istanbul to air_base 4");
console.log("- upgrades turkey:antalya to naval_base 4 and turkey:izmir to naval_base 2");
console.log("- excludes Iraq and all Greece balances");
console.log("- subtracts research cost at research start");
console.log("- subtracts mobilisation cost at queue start and unit upkeep after mobilisation completes");
console.log("- excludes deployable_gear from the mobilisation plan and assumes 40 are completed externally by map day 7");
console.log("Demand package:", demands);
console.log("Research targets:", mobilizationPlan.researchTargets);
console.log("Derived city footprint:");
console.table(mobilizationPlan.cityProfiles.map(profile => ({
  ...profile,
  assignedCities: (queueCityNames[profile.queueKey] ?? []).join(", "),
})));
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

console.log("Daily income:");
console.table(dailyTotals.map(row => ({
  mapDay: row.mapDay,
  hoursCounted: row.hoursCounted,
  ...row.income,
})));

console.log("Daily expenditure:");
console.table(dailyTotals.map(row => ({
  mapDay: row.mapDay,
  hoursCounted: row.hoursCounted,
  ...row.expenditure,
})));

console.log("End-of-day rolling balances:");
console.table([
  {
    mapDay: "START",
    hoursCounted: "",
    ...startingBalances,
  },
  ...dailyTotals.map(row => ({
    mapDay: row.mapDay,
    hoursCounted: row.hoursCounted,
    ...row.balances,
  })),
]);
