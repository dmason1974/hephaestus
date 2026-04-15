import path from "node:path";

import type { Resource, StartingPopulation } from "../../core/constants.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import {
  scheduleBuildSegments,
  type BuildAction,
  type BuildingId,
} from "../../engine/orchestration/build-order-timeline.js";
import { buildCountryHourlyResourceBalanceTable } from "../../engine/reporting/country-resource-balance.js";
import { simulateBuildOrder, type CityState } from "../../engine/simulation/build-order-sim.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import type { Country } from "../../schemas/country-schema.js";

const RESOURCE_KEYS: Resource[] = [
  "supplies",
  "components",
  "fuel",
  "rares",
  "electronics",
  "cash",
  "manpower",
];

const scenarioId = process.env.HQ_SCENARIO ?? "elite_ww3_2026";
const countryId = process.env.HQ_COUNTRY ?? "indonesia";
const destinationCityId = process.env.HQ_DEST_CITY ?? "medan";
const daysToSimulate = parsePositiveInt(process.env.HQ_DAYS, 28);
const topN = parsePositiveInt(process.env.HQ_TOP, 10);
const hoursToSimulate = daysToSimulate * 24;

const scenario = loadScenarioFile(scenarioId);
const country = loadScenarioCountry(scenarioId, countryId);
const buildings = loadBuildingsFile(path.resolve("data/buildings.yml"));
const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);

function parsePositiveInt(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function zeroResources(): Record<Resource, number> {
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

function levelData(buildingId: BuildingId, level: number) {
  const data = buildings.buildings[buildingId]?.levels[String(level) as "1" | "2" | "3" | "4" | "5"];
  if (!data) {
    throw new Error(`Missing ${buildingId} level ${level}`);
  }
  return data;
}

function toCityStates(input: Country): CityState[] {
  return input.cities.map(city => ({
    cityId: `${input.country.id}:${city.id}`,
    countryId: input.country.id,
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
  }));
}

function hourlyNetAdjustments(args: {
  hoursToSimulate: number;
  segmentsByEntity: ReturnType<typeof scheduleBuildSegments>;
}) {
  const adjustments = Array.from({ length: args.hoursToSimulate }, () => zeroResources());

  for (const buildingSegments of args.segmentsByEntity.values()) {
    for (const [buildingId, segments] of Object.entries(buildingSegments) as Array<[BuildingId, typeof buildingSegments[BuildingId]]>) {
      for (const segment of segments) {
        const startHourIndex = Math.floor(segment.startMinute / 60) - scenarioAbsHour;
        if (startHourIndex >= 0 && startHourIndex < args.hoursToSimulate) {
          const cost = levelData(buildingId, segment.toLevel).cost;
          for (const resource of RESOURCE_KEYS) {
            adjustments[startHourIndex][resource] -= cost[resource];
          }
        }

        const upkeep = levelData(buildingId, segment.toLevel).daily_upkeep;
        if (!upkeep) continue;

        const completionHourIndex = Math.ceil(segment.endMinute / 60) - scenarioAbsHour;
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

function evaluateRelocate(startHour: number) {
  const destination = country.cities.find(city => city.id === destinationCityId);
  if (!destination) {
    throw new Error(`City ${destinationCityId} not found in ${country.country.name}`);
  }

  const cities = toCityStates(country);
  const buildOrder: BuildAction[] = [
    {
      cityId: `${country.country.id}:${destinationCityId}`,
      buildingId: "relocate_headquarters",
      targetLevel: 1,
      startHour,
    },
  ];

  const baseline = simulateBuildOrder({
    cities,
    buildOrder: [],
    buildings,
    scenario,
    hoursToSimulate,
  });
  const relocated = simulateBuildOrder({
    cities,
    buildOrder,
    buildings,
    scenario,
    hoursToSimulate,
  });
  const segmentsByCity = scheduleBuildSegments({
    cities: cities.map(city => ({
      cityId: city.cityId,
      countryId: city.countryId,
      capital: city.capital,
      cityStatus: city.cityStatus,
      moraleParams: city.moraleParams,
      buildings: city.buildings,
    })),
    buildOrder,
    buildings,
    scenario,
  });
  const adjustments = hourlyNetAdjustments({
    hoursToSimulate,
    segmentsByEntity: segmentsByCity,
  });

  const delta = zeroResources();
  for (let hourIndex = 0; hourIndex < hoursToSimulate; hourIndex++) {
    for (const resource of RESOURCE_KEYS) {
      delta[resource] +=
        (relocated.perHourAggregate[hourIndex]?.production[resource] ?? 0) -
        (baseline.perHourAggregate[hourIndex]?.production[resource] ?? 0) +
        adjustments[hourIndex][resource];
    }
  }

  return {
    startHour,
    startAbsoluteHour: scenarioAbsHour + startHour,
    startDay: mapDayForAbsoluteHour(scenarioAbsHour + startHour),
    startHourOfDay: hourOfDayForAbsoluteHour(scenarioAbsHour + startHour),
    delta,
  };
}

const destination = country.cities.find(city => city.id === destinationCityId);
if (!destination) {
  throw new Error(`City ${destinationCityId} not found in ${country.country.name}`);
}

const baselineCountry = buildCountryHourlyResourceBalanceTable(
  country,
  daysToSimulate,
  scenario.speed,
  {
    buildingsFile: buildings,
    scenario,
    startAbsoluteHour: scenarioAbsHour,
  }
);

const relocateCost = levelData("relocate_headquarters", 1).cost;
const feasibleStartHours: number[] = [];

for (let hourIndex = 0; hourIndex < hoursToSimulate; hourIndex++) {
  const balances = baselineCountry.rows[hourIndex]?.balances ?? zeroResources();
  if (
    balances.cash >= relocateCost.cash &&
    balances.manpower >= relocateCost.manpower
  ) {
    feasibleStartHours.push(hourIndex);
  }
}

if (feasibleStartHours.length === 0) {
  throw new Error("Relocate headquarters is not affordable within the simulation window");
}

const results = feasibleStartHours
  .map(hour => evaluateRelocate(hour))
  .sort((a, b) =>
    (b.delta.electronics - a.delta.electronics) ||
    (b.delta.cash - a.delta.cash) ||
    (b.delta.manpower - a.delta.manpower) ||
    (a.startHour - b.startHour)
  );

const bestByCash = [...results].sort((a, b) =>
  (b.delta.cash - a.delta.cash) ||
  (b.delta.electronics - a.delta.electronics) ||
  (a.startHour - b.startHour)
)[0];

console.log("Elite WW3 headquarters timing");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(`Country: ${country.country.name}`);
console.log(`Destination city: ${destination.name} (${destination.resource})`);
console.log(`Window: ${daysToSimulate} days (${hoursToSimulate} hours)`);
console.log("Assumptions:");
console.log("- compares country city-economy with no relocate versus relocate_headquarters level 1");
console.log("- provinces are unchanged, so timing comparison is driven by city-economy delta plus relocate cost/upkeep");
console.log("- affordability uses baseline country balances for cash and manpower");
console.log("- ranking below is by electronics delta, then cash delta");
console.log(
  `Earliest affordable relocate start: day ${mapDayForAbsoluteHour(scenarioAbsHour + feasibleStartHours[0])}, hour ${hourOfDayForAbsoluteHour(scenarioAbsHour + feasibleStartHours[0])}`
);

console.log("Best timings for electronics:");
console.table(
  results.slice(0, topN).map(entry => ({
    startDay: entry.startDay,
    startHour: entry.startHourOfDay,
    electronicsDelta: entry.delta.electronics,
    cashDelta: entry.delta.cash,
    suppliesDelta: entry.delta.supplies,
    componentsDelta: entry.delta.components,
    fuelDelta: entry.delta.fuel,
    raresDelta: entry.delta.rares,
    manpowerDelta: entry.delta.manpower,
  }))
);

if (bestByCash) {
  console.log("Best timing for cash:");
  console.table([{
    startDay: bestByCash.startDay,
    startHour: bestByCash.startHourOfDay,
    electronicsDelta: bestByCash.delta.electronics,
    cashDelta: bestByCash.delta.cash,
    suppliesDelta: bestByCash.delta.supplies,
    componentsDelta: bestByCash.delta.components,
    fuelDelta: bestByCash.delta.fuel,
    raresDelta: bestByCash.delta.rares,
    manpowerDelta: bestByCash.delta.manpower,
  }]);
}
