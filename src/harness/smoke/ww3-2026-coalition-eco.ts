import path from "node:path";

import type {
  Resource,
  StartingPopulation,
} from "../../core/constants.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
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
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import type { Country } from "../../schemas/country-schema.js";

const scenarioId = "elite_ww3_2026";
const buildingsFile = loadBuildingsFile(path.resolve("data/buildings.yml"));
const scenario = loadScenarioFile(scenarioId);

// Load coalition countries
const austria = loadScenarioCountry(scenarioId, "austria");
const france = loadScenarioCountry(scenarioId, "france");
const unitedKingdom = loadScenarioCountry(scenarioId, "united_kingdom");
const italy = loadScenarioCountry(scenarioId, "italy");
const spain = loadScenarioCountry(scenarioId, "spain");

const coalitionCountries = [austria, france, unitedKingdom, italy, spain];

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

function toCityStates(country: Country): CityState[] {
  return country.cities.map(city => ({
    cityId: `${country.country.id}:${city.id}`,
    countryId: country.country.id,
    capital: city.capital,
    resource: city.resource as Exclude<Resource, "cash" | "manpower">,
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
      army_base: 0,
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

// Custom build order: RO1 then AI1 for all cities
function buildCityBuildOrder(country: Country): BuildAction[] {
  const actions: BuildAction[] = [];

  for (const city of country.cities) {
    const cityId = `${country.country.id}:${city.id}`;

    // RO1 first
    actions.push({
      cityId,
      buildingId: "recruiting_office",
      targetLevel: 1,
    });

    // Then AI1
    actions.push({
      cityId,
      buildingId: "arms_industry",
      targetLevel: 1,
    });
  }

  return actions;
}

// Custom build order: CO1 then LI3 for all resource provinces
function buildProvinceBuildOrder(country: Country): ProvinceBuildAction[] {
  return buildProvinceCohortsFromCountry(country)
    .filter(cohort => cohort.resource !== null) // Only resource provinces
    .flatMap(cohort => {
      const actions: ProvinceBuildAction[] = [];

      // CO1 first
      actions.push({
        provinceId: cohort.provinceId,
        buildingId: "combat_outpost",
        targetLevel: 1,
      });

      // Then LI3
      actions.push({
        provinceId: cohort.provinceId,
        buildingId: "local_industry",
        targetLevel: 3,
      });

      return actions;
    });
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

// Simulate up to day 8
const hoursToSimulate = 8 * 24;
const daysToSimulate = Math.ceil(hoursToSimulate / 24);
const simulationStartAbsoluteHour = startAbsoluteHour(scenario.start.day, scenario.start.hour);

// Simulate each country
const countrySimulations = coalitionCountries.map(country => {
  const cities = toCityStates(country);
  const cityBuildOrder = buildCityBuildOrder(country);
  const provinceCohorts = buildProvinceCohortsFromCountry(country);
  const provinceBuildOrder = buildProvinceBuildOrder(country);

  const citySim = simulateBuildOrder({
    cities,
    buildOrder: cityBuildOrder,
    buildings: buildingsFile,
    scenario,
    hoursToSimulate,
  });

  const provinceSim = simulateProvinceBuildOrder({
    provinces: provinceCohorts,
    buildOrder: provinceBuildOrder,
    buildings: buildingsFile,
    scenario,
    hoursToSimulate,
  });

  const citySegments = scheduleBuildSegments({
    cities: toTimelineCityStates(cities),
    buildOrder: cityBuildOrder,
    buildings: buildingsFile,
    scenario,
  });

  const provinceSegments = scheduleBuildSegments({
    cities: toTimelineProvinceStates(provinceCohorts),
    buildOrder: provinceBuildOrder.map(action => ({
      cityId: action.provinceId,
      buildingId: action.buildingId,
      targetLevel: action.targetLevel,
    })),
    buildings: buildingsFile,
    scenario,
  });

  const cityCostAdjustments = hourlyNetAdjustments({
    hoursToSimulate,
    segmentsByEntity: citySegments,
  });

  const provinceCostAdjustments = hourlyNetAdjustments({
    hoursToSimulate,
    segmentsByEntity: provinceSegments,
  });

  return {
    country,
    citySim,
    provinceSim,
    cityCostAdjustments,
    provinceCostAdjustments,
  };
});

// Aggregate coalition hourly production
const coalitionHourly = Array.from({ length: hoursToSimulate }, (_, index) => {
  const absoluteHour = simulationStartAbsoluteHour + index;
  const production = zeroProduction();

  for (const sim of countrySimulations) {
    for (const resource of RESOURCE_KEYS) {
      production[resource] += sim.citySim.perHourAggregate[index]?.production[resource] ?? 0;
      production[resource] += sim.provinceSim.perHourAggregate[index]?.production[resource] ?? 0;
      production[resource] += sim.cityCostAdjustments[index]?.[resource] ?? 0;
      production[resource] += sim.provinceCostAdjustments[index]?.[resource] ?? 0;
    }
  }

  return {
    hour: index + 1,
    absoluteHour,
    production,
  };
});

const mapDaysToReport = 9; // Day 1 through Day 8 plus partial day 9 if needed
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

const coalitionCountryCount = coalitionCountries.length;
const startingBalances = Object.fromEntries(
  RESOURCE_KEYS.map(resource => [
    resource,
    scenario.starting_balance[resource] * coalitionCountryCount,
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
console.log("\nCoalition Countries:");
console.log(`- ${coalitionCountries.map(c => c.country.name).join(", ")}`);
console.log("\nAssumptions:");
console.log("- scenario starting resources are applied once per coalition country and included in rolling and ending balances");
console.log("- net balances subtract build cost at segment start and subtract hourly upkeep after completion");
console.log("- all countries are homeland status");
console.log("\nCity build program:");
console.log("- recruiting_office level 1 first in all cities");
console.log("- arms_industry level 1 second in all cities");
console.log("\nProvince build program:");
console.log("- combat_outpost level 1 first in all resource provinces");
console.log("- local_industry level 3 second in all resource provinces");
console.log("\nProvince counts by country:");
for (const country of coalitionCountries) {
  const cohorts = buildProvinceCohortsFromCountry(country);
  const resourceProvinces = cohorts.filter(c => c.resource !== null);
  const byResource = resourceProvinces.reduce((acc, c) => {
    const key = c.resource || "none";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  console.log(`- ${country.country.name}: ${country.provinces.total} total, ${resourceProvinces.length} resource provinces`, byResource);
}
console.log("\nWindow:");
console.log({
  hoursToSimulate,
  endMapDay: Math.floor(endAbsoluteHour / 24) + 1,
  endHourOfDay: endAbsoluteHour % 24,
});
console.log("\nDaily running coalition balances:");
console.table([
  {
    mapDay: "START",
    hoursCounted: 0,
    ...startingBalances,
  },
  ...dailyRolling,
]);
console.log("\nDaily net production:");
console.table(dailyNet);
console.log("\nTotals:");
console.table([
  {
    label: "Net Production",
    ...totals,
  },
  {
    label: "Starting Balance",
    ...startingBalances,
  },
  {
    label: "Ending Balance",
    ...endingBalances,
  },
]);

// Made with Bob
