import path from "node:path";

import type {
  Resource,
  StartingPopulation,
} from "../../core/constants.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import { aggregateHourlyAmountsByMapDay } from "../../engine/reporting/scenario-reporting.js";
import { buildCountryHourlyResourceBalanceTable } from "../../engine/reporting/country-resource-balance.js";
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
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import type { Country } from "../../schemas/country-schema.js";
import {
  buildHomelandCityBuildOrderFromBaseline,
  buildHomelandProvinceBuildOrderFromBaseline,
  challengeHomelandEcoBaseline,
} from "./default-eco-baseline.js";

const scenarioId = "elite/ww3";
const buildingsFile = loadBuildingsFile(path.resolve("data/buildings.yml"));
const scenario = loadScenarioFile(scenarioId);
const turkey = loadScenarioCountry(scenarioId, "turkey");
const iraq = loadScenarioCountry(scenarioId, "iraq");
const greece = loadScenarioCountry(scenarioId, "greece");

const RESOURCE_KEYS: Resource[] = [
  "supplies",
  "components",
  "fuel",
  "rares",
  "electronics",
  "cash",
  "manpower",
];

function startAbsoluteHour(day: number, hour: number) {
  return ((day - 1) * 24) + hour;
}

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

function levelData(buildingId: BuildingId, toLevel: number) {
  const level = buildingsFile.buildings[buildingId]?.levels[String(toLevel) as "1" | "2" | "3" | "4" | "5"];
  if (!level) {
    throw new Error(`Missing level data for ${buildingId} level ${toLevel}`);
  }
  return level;
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

const hoursToSimulate = 28 * 24;
const daysToSimulate = Math.ceil(hoursToSimulate / 24);
const simulationStartAbsoluteHour = startAbsoluteHour(scenario.start.day, scenario.start.hour);
const greeceOccupationStartAbsoluteHour = startAbsoluteHour(3, 0);
const greeceOccupationStartHour = greeceOccupationStartAbsoluteHour - simulationStartAbsoluteHour;

function occupiedGreekCityState(cityId: string): CityState {
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
    cityStatus: "occupied",
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
  };
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
  const costAdjustments = hourlyNetAdjustments({
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
      delta[resource] += costAdjustments[index][resource] ?? 0;
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

const turkeyCitySim = simulateBuildOrder({
  cities: toCityStates(turkey),
  buildOrder: buildHomelandCityBuildOrderFromBaseline(turkey, challengeHomelandEcoBaseline),
  buildings: buildingsFile,
  scenario,
  hoursToSimulate,
});

const iraqCitySim = simulateBuildOrder({
  cities: toCityStates(iraq),
  buildOrder: buildHomelandCityBuildOrderFromBaseline(iraq, challengeHomelandEcoBaseline),
  buildings: buildingsFile,
  scenario,
  hoursToSimulate,
});

const turkeyCities = toCityStates(turkey);
const iraqCities = toCityStates(iraq);
const turkeyCityBuildOrder = buildHomelandCityBuildOrderFromBaseline(turkey, challengeHomelandEcoBaseline);
const iraqCityBuildOrder = buildHomelandCityBuildOrderFromBaseline(iraq, challengeHomelandEcoBaseline);
const turkeyProvinceCohorts = buildProvinceCohortsFromCountry(turkey);
const iraqProvinceCohorts = buildProvinceCohortsFromCountry(iraq);
const turkeyProvinceBuildOrder = buildHomelandProvinceBuildOrderFromBaseline(turkey, challengeHomelandEcoBaseline);
const iraqProvinceBuildOrder = buildHomelandProvinceBuildOrderFromBaseline(iraq, challengeHomelandEcoBaseline);

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
  buildOrder: turkeyCityBuildOrder,
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
const greekElectronicsPlan = buildGreekCityPlan("thessaloniki");
const greekSuppliesPlan = buildGreekCityPlan("heraklion");
const greekCityPlans = [greekElectronicsPlan, greekSuppliesPlan];

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

const mapDaysToReport = 29;
const dailyNet = Array.from({ length: mapDaysToReport }, (_, index) => {
  const mapDay = scenario.start.day + index;
  const row = {
    mapDay,
    hoursCounted: 0,
    supplies: 0,
    components: 0,
    fuel: 0,
    rares: 0,
    electronics: 0,
    cash: 0,
    manpower: 0,
  };

  for (const resource of RESOURCE_KEYS) {
    const aggregated = aggregateHourlyAmountsByMapDay({
      rows: coalitionHourly.map(entry => ({ hour: entry.hour, amount: entry.production[resource] })),
      scenario,
      mapDaysToReport,
    });
    const dayRow = aggregated.find(entry => entry.mapDay === mapDay);
    row[resource] = dayRow?.total ?? 0;
    row.hoursCounted = dayRow?.hoursCounted ?? 0;
  }

  return row;
});

const totals = dailyNet.reduce((acc, row) => {
  for (const resource of RESOURCE_KEYS) {
    acc[resource] += row[resource];
  }
  return acc;
}, zeroProduction());

const homelandCoalitionCountryCount = 2;
const startingBalances = Object.fromEntries(
  RESOURCE_KEYS.map(resource => [
    resource,
    scenario.starting_balance[resource] * homelandCoalitionCountryCount,
  ])
) as Record<Resource, number>;
const endingBalances = Object.fromEntries(
  RESOURCE_KEYS.map(resource => [resource, startingBalances[resource] + totals[resource]])
) as Record<Resource, number>;
const dailyRolling = dailyNet.reduce<Array<{
  mapDay: number;
  hoursCounted: number;
} & Record<Resource, number>>>((rows, row) => {
  const previous = rows.at(-1);
  rows.push({
    mapDay: row.mapDay,
    hoursCounted: row.hoursCounted,
    supplies: (previous?.supplies ?? startingBalances.supplies) + row.supplies,
    components: (previous?.components ?? startingBalances.components) + row.components,
    fuel: (previous?.fuel ?? startingBalances.fuel) + row.fuel,
    rares: (previous?.rares ?? startingBalances.rares) + row.rares,
    electronics: (previous?.electronics ?? startingBalances.electronics) + row.electronics,
    cash: (previous?.cash ?? startingBalances.cash) + row.cash,
    manpower: (previous?.manpower ?? startingBalances.manpower) + row.manpower,
  });
  return rows;
}, []);

const endAbsoluteHour = simulationStartAbsoluteHour + hoursToSimulate;

console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(
  `Scenario start: day ${scenario.start.day}, hour ${scenario.start.hour}, t0=${scenarioStartAbsoluteHour(
    scenario
  )}`
);
console.log("Assumptions:");
console.log("- scenario starting resources are applied once per homeland coalition country and included in rolling and ending balances");
console.log("- net balances subtract build cost at segment start and subtract hourly upkeep after completion");
console.log("- Greece is occupied from start of map day 3");
console.log("- Turkey and Iraq homeland cities build in parallel per city");
console.log("- Turkey and Iraq homeland provinces build only in electronics province cohorts");
console.log("- Greece city plans are added on top of occupied-city income:");
console.log("  - greece:thessaloniki -> RO1, annex, AI1, bunkers 3, AI5");
console.log("  - greece:heraklion -> RO1, annex, AI1, bunkers 3, AI5");
console.log("- no buildings in non-electronics homeland province cohorts");
console.log(`City build program: ${challengeHomelandEcoBaseline.name}`);
console.log("- recruiting_office level 1 first in all Turkey and Iraq homeland cities");
console.log("- supplies cities: arms_industry to level 5");
console.log("- components cities: arms_industry to level 2");
console.log("- fuel cities: arms_industry to level 1");
console.log("- electronics cities: arms_industry to level 1, relocate_headquarters, then arms_industry to level 5");
console.log("- rares cities: arms_industry to level 5");
console.log("Province build program:");
console.log("- Turkey and Iraq electronics provinces: combat_outpost level 1, then local_industry to level 3");
console.log("Greek city plan net 28-day totals:");
console.table(greekCityPlans.map(plan => ({
  cityId: plan.cityId,
  ...plan.totals,
})));
console.log("Window:");
console.log({
  hoursToSimulate,
  endMapDay: Math.floor(endAbsoluteHour / 24) + 1,
  endHourOfDay: endAbsoluteHour % 24,
});
console.log("Daily running coalition balances:");
console.table([
  {
    mapDay: "START",
    hoursCounted: "",
    ...startingBalances,
  },
  ...dailyRolling,
  {
    mapDay: "ENDING",
    hoursCounted: "",
    ...endingBalances,
  },
]);

console.log("Daily net coalition change:");
console.table([
  ...dailyNet,
  {
    mapDay: "TOTAL",
    hoursCounted: "",
    ...totals,
  },
]);
