import path from "node:path";

import type {
  Resource,
  StartingPopulation,
} from "../../core/constants.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import { buildCountryHourlyResourceBalanceTable } from "../../engine/reporting/country-resource-balance.js";
import { aggregateHourlyAmountsByMapDay } from "../../engine/reporting/scenario-reporting.js";
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
const turkey = loadScenarioCountry(scenarioId, "turkey");
const iraq = loadScenarioCountry(scenarioId, "iraq");
const greece = loadScenarioCountry(scenarioId, "greece");
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
  { unitId: "naval_veteran", count: 1 },
  { unitId: "fixed_wing_veteran", count: 1, researchTargetLevel: 6 },
  { unitId: "epic_airstrike_officer", count: 1, researchTargetLevel: 6 },
  { unitId: "awacs", count: 4, researchTargetLevel: 6 },
  { unitId: "airborne_infantry", count: 20 },
  { unitId: "air_superiority_fighter", count: 18 },
  { unitId: "elite_frigate", count: 9 },
  { unitId: "elite_drone_mothership", count: 10 },
];
const deployableGearCount = 40;

const hoursToSimulate = 28 * 24;
const daysToSimulate = Math.ceil(hoursToSimulate / 24);
const simulationStartAbsoluteHour = scenarioStartAbsoluteHour(scenario);
const greeceOccupationStartAbsoluteHour = ((3 - 1) * 24) + 0;
const greeceOccupationStartHour = greeceOccupationStartAbsoluteHour - simulationStartAbsoluteHour;

function zeroProduction(): Record<Resource, number> {
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

function hourlyProductionDeltas(
  table: ReturnType<typeof buildCountryHourlyResourceBalanceTable>,
  absoluteHourOffset: number
) {
  return table.rows.map((row, index) => {
    const previous = index === 0 ? null : table.rows[index - 1]?.balances;
    const deltas = Object.fromEntries(
      RESOURCE_KEYS.map(resource => [
        resource,
        previous ? row.balances[resource] - previous[resource] : row.balances[resource],
      ])
    ) as Record<Resource, number>;

    return {
      absoluteHour: absoluteHourOffset + index,
      production: deltas,
    };
  });
}

function levelData(buildingId: BuildingId, toLevel: number) {
  const level = buildingsFile.buildings[buildingId]?.levels[String(toLevel) as "1" | "2" | "3" | "4" | "5"];
  if (!level) {
    throw new Error(`Missing level data for ${buildingId} level ${toLevel}`);
  }
  return level;
}

function occupiedGreekCityState(cityId: string) {
  const city = greece.cities.find(entry => entry.id === cityId);
  if (!city) {
    throw new Error(`unknown Greece city "${cityId}"`);
  }

  return {
    cityId: `greece:${city.id}`,
    countryId: "greece",
    capital: city.capital,
    resource: city.resource,
    startPop: city.population as StartingPopulation,
    cityStatus: "occupied" as const,
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
  } satisfies CityState;
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
  const adjustments = Array.from({ length: args.hoursToSimulate }, () => zeroProduction());

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

function hourlyUnitAdjustments() {
  const adjustments = Array.from({ length: hoursToSimulate }, () => zeroProduction());
  const mobilizationPlan = planMobilizationBuild({
    catalog: mergedCatalog,
    buildings: buildingsFile,
    scenario,
    demands,
  });

  for (const spend of mobilizationPlan.researchPlan.spendingByAbsoluteHour) {
    const hourIndex = spend.absoluteHour - simulationStartAbsoluteHour;
    if (hourIndex < 0 || hourIndex >= hoursToSimulate) continue;
    for (const resource of RESOURCE_KEYS) {
      adjustments[hourIndex][resource] -= spend.cost[resource];
    }
  }

  for (const segment of mobilizationPlan.segments) {
    const level = unitLevel(segment.unitId, segment.mobilizeLevel);
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

  // Deployable Gear has no research or upkeep. We back-load it so it cannot interfere
  // with earlier research/building/mobilisation bottlenecks in this first-pass validator.
  const deployableGear = unitLevel("deployable_gear", 1);
  for (let index = 0; index < deployableGearCount; index++) {
    const hourIndex = (hoursToSimulate - deployableGearCount) + index;
    if (hourIndex < 0 || hourIndex >= hoursToSimulate) continue;
    for (const resource of RESOURCE_KEYS) {
      adjustments[hourIndex][resource] -= deployableGear.mobilisation.cost[resource];
    }
  }

  return { adjustments, mobilizationPlan };
}

function buildGreekCityPlan(cityId: string) {
  const city = occupiedGreekCityState(cityId);
  const buildOrder: BuildAction[] = [
    { cityId: city.cityId, buildingId: "recruiting_office", targetLevel: 1, startHour: greeceOccupationStartHour },
    { cityId: city.cityId, buildingId: "annex_city", targetLevel: 1, startHour: greeceOccupationStartHour },
    { cityId: city.cityId, buildingId: "arms_industry", targetLevel: 1, startHour: greeceOccupationStartHour },
    { cityId: city.cityId, buildingId: "underground_bunkers", targetLevel: 3, startHour: greeceOccupationStartHour },
    { cityId: city.cityId, buildingId: "arms_industry", targetLevel: 5, startHour: greeceOccupationStartHour },
  ];

  const baseline = simulateBuildOrder({
    cities: [city],
    buildOrder: [],
    buildings: buildingsFile,
    scenario,
    hoursToSimulate,
  });
  const planned = simulateBuildOrder({
    cities: [city],
    buildOrder,
    buildings: buildingsFile,
    scenario,
    hoursToSimulate,
  });
  const adjustments = hourlyNetAdjustments({
    hoursToSimulate,
    segmentsByEntity: scheduleBuildSegments({
      cities: toTimelineCityStates([city]),
      buildOrder,
      buildings: buildingsFile,
      scenario,
    }),
  });

  const hourlyDelta = Array.from({ length: hoursToSimulate }, (_, index) => {
    const delta = zeroProduction();
    for (const resource of RESOURCE_KEYS) {
      delta[resource] += (planned.perHourAggregate[index]?.production[resource] ?? 0);
      delta[resource] -= (baseline.perHourAggregate[index]?.production[resource] ?? 0);
      delta[resource] += adjustments[index][resource] ?? 0;
    }
    return {
      absoluteHour: simulationStartAbsoluteHour + index,
      delta,
    };
  });

  const totals = hourlyDelta.reduce((acc, hour) => {
    for (const resource of RESOURCE_KEYS) {
      acc[resource] += hour.delta[resource];
    }
    return acc;
  }, zeroProduction());

  return {
    cityId: city.cityId,
    hourlyDelta,
    totals,
  };
}

const occupiedGreeceScenario = {
  ...scenario,
  city_statuses: {
    ...(scenario.city_statuses ?? {}),
    greece: Object.fromEntries(greece.cities.map(city => [city.id, "occupied" as const])),
  },
};

const turkeyCities = toCityStates(turkey);
const iraqCities = toCityStates(iraq);
const turkeyCityBuildOrder = buildHomelandCityBuildOrderFromBaseline(turkey, challengeHomelandEcoBaseline);
const iraqCityBuildOrder = buildHomelandCityBuildOrderFromBaseline(iraq, challengeHomelandEcoBaseline);
const turkeyForceCityBuildOrder = [
  ...turkeyCityBuildOrder,
  {
    cityId: "turkey:ankara",
    buildingId: "army_base" as const,
    targetLevel: 1,
  },
  {
    cityId: "turkey:istanbul",
    buildingId: "army_base" as const,
    targetLevel: 1,
  },
  {
    cityId: "turkey:ankara",
    buildingId: "air_base" as const,
    targetLevel: 2,
  },
  {
    cityId: "turkey:istanbul",
    buildingId: "air_base" as const,
    targetLevel: 4,
  },
  {
    cityId: "turkey:istanbul",
    buildingId: "naval_base" as const,
    targetLevel: 4,
  },
];
const turkeyProvinceCohorts = buildProvinceCohortsFromCountry(turkey);
const iraqProvinceCohorts = buildProvinceCohortsFromCountry(iraq);
const turkeyProvinceBuildOrder = buildHomelandProvinceBuildOrderFromBaseline(turkey, challengeHomelandEcoBaseline);
const iraqProvinceBuildOrder = buildHomelandProvinceBuildOrderFromBaseline(iraq, challengeHomelandEcoBaseline);

const turkeyCitySim = simulateBuildOrder({
  cities: turkeyCities,
  buildOrder: turkeyForceCityBuildOrder,
  buildings: buildingsFile,
  scenario,
  hoursToSimulate,
});
const iraqCitySim = simulateBuildOrder({
  cities: iraqCities,
  buildOrder: iraqCityBuildOrder,
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
const iraqProvinceSim = simulateProvinceBuildOrder({
  provinces: iraqProvinceCohorts,
  buildOrder: iraqProvinceBuildOrder,
  buildings: buildingsFile,
  scenario,
  hoursToSimulate,
});

const greeceOccupiedTable = buildCountryHourlyResourceBalanceTable(
  greece,
  daysToSimulate,
  scenario.speed,
  {
    buildingsFile,
    scenario: occupiedGreeceScenario,
    startAbsoluteHour: simulationStartAbsoluteHour,
    provinceDefaults: {
      cityStatus: "occupied",
    },
  }
);

const turkeyCitySegments = scheduleBuildSegments({
  cities: toTimelineCityStates(turkeyCities),
  buildOrder: turkeyForceCityBuildOrder,
  buildings: buildingsFile,
  scenario,
});
const iraqCitySegments = scheduleBuildSegments({
  cities: toTimelineCityStates(iraqCities),
  buildOrder: iraqCityBuildOrder,
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

const turkeyCityCostAdjustments = hourlyNetAdjustments({
  hoursToSimulate,
  segmentsByEntity: turkeyCitySegments,
});
const iraqCityCostAdjustments = hourlyNetAdjustments({
  hoursToSimulate,
  segmentsByEntity: iraqCitySegments,
});
const turkeyProvinceCostAdjustments = hourlyNetAdjustments({
  hoursToSimulate,
  segmentsByEntity: turkeyProvinceSegments,
});
const iraqProvinceCostAdjustments = hourlyNetAdjustments({
  hoursToSimulate,
  segmentsByEntity: iraqProvinceSegments,
});
const { adjustments: unitAdjustments, mobilizationPlan } = hourlyUnitAdjustments();
const greekElectronicsPlan = buildGreekCityPlan("thessaloniki");
const greekSuppliesPlan = buildGreekCityPlan("heraklion");
const greekCityPlans = [greekElectronicsPlan, greekSuppliesPlan];

const turkeyCityHourly = turkeyCitySim.perHourAggregate.map((row, index) => ({
  absoluteHour: simulationStartAbsoluteHour + index,
  production: row.production,
}));
const iraqCityHourly = iraqCitySim.perHourAggregate.map((row, index) => ({
  absoluteHour: simulationStartAbsoluteHour + index,
  production: row.production,
}));
const turkeyProvinceHourly = turkeyProvinceSim.perHourAggregate.map((row, index) => ({
  absoluteHour: simulationStartAbsoluteHour + index,
  production: row.production,
}));
const iraqProvinceHourly = iraqProvinceSim.perHourAggregate.map((row, index) => ({
  absoluteHour: simulationStartAbsoluteHour + index,
  production: row.production,
}));
const greeceHourly = hourlyProductionDeltas(greeceOccupiedTable, simulationStartAbsoluteHour).slice(0, hoursToSimulate);

const coalitionHourly = Array.from({ length: hoursToSimulate }, (_, index) => {
  const absoluteHour = simulationStartAbsoluteHour + index;
  const production = zeroProduction();

  for (const resource of RESOURCE_KEYS) {
    production[resource] += turkeyCityHourly[index]?.production[resource] ?? 0;
    production[resource] += iraqCityHourly[index]?.production[resource] ?? 0;
    production[resource] += turkeyProvinceHourly[index]?.production[resource] ?? 0;
    production[resource] += iraqProvinceHourly[index]?.production[resource] ?? 0;
    production[resource] += absoluteHour >= greeceOccupationStartAbsoluteHour
      ? (greeceHourly[index]?.production[resource] ?? 0)
      : 0;
    production[resource] += turkeyCityCostAdjustments[index]?.[resource] ?? 0;
    production[resource] += iraqCityCostAdjustments[index]?.[resource] ?? 0;
    production[resource] += turkeyProvinceCostAdjustments[index]?.[resource] ?? 0;
    production[resource] += iraqProvinceCostAdjustments[index]?.[resource] ?? 0;
    production[resource] += unitAdjustments[index]?.[resource] ?? 0;
    for (const greekPlan of greekCityPlans) {
      production[resource] += greekPlan.hourlyDelta[index]?.delta[resource] ?? 0;
    }
  }

  return {
    hour: index + 1,
    absoluteHour,
    production,
  };
});

const homelandCoalitionCountryCount = 2;
const startingBalances = Object.fromEntries(
  RESOURCE_KEYS.map(resource => [
    resource,
    scenario.starting_balance[resource] * homelandCoalitionCountryCount,
  ])
) as Record<Resource, number>;

const rollingRows = coalitionHourly.reduce<Array<{
  absoluteHour: number;
  mapDay: number;
  hourOfDay: number;
  balances: Record<Resource, number>;
}>>((rows, row) => {
  const previous = rows.at(-1)?.balances ?? startingBalances;
  const balances = zeroProduction();
  for (const resource of RESOURCE_KEYS) {
    balances[resource] = previous[resource] + row.production[resource];
  }
  rows.push({
    absoluteHour: row.absoluteHour,
    mapDay: mapDayForAbsoluteHour(row.absoluteHour),
    hourOfDay: hourOfDayForAbsoluteHour(row.absoluteHour),
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
const dailyRolling = Array.from({ length: 29 }, (_, index) => {
  const mapDay = scenario.start.day + index;
  const endOfDay = rollingRows
    .filter(row => row.mapDay === mapDay)
    .at(-1);

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

const researchDailySpend = Array.from({ length: 29 }, (_, index) => {
  const mapDay = scenario.start.day + index;
  const row = { mapDay, ...zeroProduction() };
  for (const resource of RESOURCE_KEYS) {
    const aggregated = aggregateHourlyAmountsByMapDay({
      rows: mobilizationPlan.researchPlan.spendingByAbsoluteHour.map(entry => ({
        hour: entry.absoluteHour - simulationStartAbsoluteHour + 1,
        amount: entry.cost[resource],
      })),
      scenario,
      mapDaysToReport: 29,
    });
    row[resource] = aggregated.find(entry => entry.mapDay === mapDay)?.total ?? 0;
  }
  return row;
});

console.log("Elite WW3 force validator");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log("Assumptions:");
console.log(`- validates the requested force package against the ${challengeHomelandEcoBaseline.name} homeland eco baseline plus the coalition overlays in this smoke`);
console.log("- adds one mobilisation port path by upgrading turkey:istanbul naval_base from 1 to 4");
console.log("- upgrades turkey:ankara to army_base 1 and air_base 2 for airborne infantry");
console.log("- upgrades turkey:istanbul to army_base 1 and air_base 4 for awacs and parallel air mobilisation");
console.log("- uses existing starting air_base 1 capitals plus recruiting_office 1 from the eco build");
console.log("- subtracts research cost at research start");
console.log("- subtracts mobilisation cost at queue start and unit upkeep after mobilisation completes");
console.log(`- back-loads ${deployableGearCount} deployable_gear in the final ${deployableGearCount} hours because it has no research or upkeep`);
console.log("- Greece is occupied from map day 3");
console.log("- Greece city plan additions:");
console.log("  - thessaloniki: RO1, annex, AI1, bunkers 3, AI5");
console.log("  - heraklion: RO1, annex, AI1, bunkers 3, AI5");
console.log("Demand package:", demands);
console.log("Research targets:", mobilizationPlan.researchTargets);
console.log("Derived city footprint:");
console.table(mobilizationPlan.cityProfiles);
console.log("Greek city plan net 28-day totals:");
console.table(greekCityPlans.map(plan => ({
  cityId: plan.cityId,
  ...plan.totals,
})));
console.log("Research spend by map day:");
console.table(researchDailySpend.filter(row => RESOURCE_KEYS.some(resource => row[resource] !== 0)));
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
  ...dailyRolling,
]);
