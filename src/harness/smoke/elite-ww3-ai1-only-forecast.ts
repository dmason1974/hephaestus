import path from "node:path";

import type { Resource } from "../../core/constants.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import { aggregateHourlyAmountsByMapDay } from "../../engine/reporting/scenario-reporting.js";
import type { BuildAction, CityState } from "../../engine/simulation/build-order-sim.js";
import { simulateBuildOrder } from "../../engine/simulation/build-order-sim.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import type { Country } from "../../schemas/country-schema.js";

const scenarioId = "elite/ww3";
const buildingsFile = loadBuildingsFile(path.resolve("data/buildings.yml"));
const scenario = loadScenarioFile(scenarioId);

const coalitionIds = scenario.coalition ?? [];
if (coalitionIds.length === 0) {
  throw new Error(`Scenario ${scenarioId} has no coalition field`);
}

const coalitionCountries = coalitionIds.map(id => loadScenarioCountry(scenarioId, id));

const RESOURCE_KEYS: Resource[] = [
  "supplies",
  "components",
  "fuel",
  "rares",
  "electronics",
  "cash",
  "manpower",
];

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

function levelData(buildingId: "arms_industry", toLevel: number) {
  const level = buildingsFile.buildings[buildingId]?.levels[String(toLevel) as "1" | "2" | "3" | "4" | "5"];
  if (!level) throw new Error(`Missing level data for ${buildingId} level ${toLevel}`);
  return level;
}

function toCityStates(country: Country): CityState[] {
  return country.cities.map(city => ({
    cityId: `${country.country.id}:${city.id}`,
    countryId: country.country.id,
    capital: city.capital,
    resource: city.resource as Exclude<Resource, "cash" | "manpower">,
    startPop: city.population as CityState["startPop"],
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

// Build order: arms_industry level 1 only, in every city — nothing else.
function buildCityBuildOrder(country: Country): BuildAction[] {
  return country.cities.map(city => ({
    cityId: `${country.country.id}:${city.id}`,
    buildingId: "arms_industry" as const,
    targetLevel: 1,
  }));
}

const truceLengthDays = scenario.truce_length_days ?? 28;
const hoursToSimulate = truceLengthDays * 24;
const simulationStartAbsoluteHour = scenarioStartAbsoluteHour(scenario);
void simulationStartAbsoluteHour;

const countrySimulations = coalitionCountries.map(country => {
  const cities = toCityStates(country);
  const cityBuildOrder = buildCityBuildOrder(country);

  const citySim = simulateBuildOrder({
    cities,
    buildOrder: cityBuildOrder,
    buildings: buildingsFile,
    scenario,
    hoursToSimulate,
  });

  // arms_industry L1 one-time cost + upkeep. Every city starts this build at hour 0
  // since it's the only queued action, so cost lands at hour 0 and upkeep starts once
  // the build completes.
  const buildLevel = levelData("arms_industry", 1);
  const buildHours = Math.ceil(
    (buildLevel.build_time.days ?? 0) * 24 + (buildLevel.build_time.hours ?? 0) + (buildLevel.build_time.minutes ?? 0) / 60
  );

  const costAdjustments = Array.from({ length: hoursToSimulate }, () => zeroProduction());
  for (const resource of RESOURCE_KEYS) {
    const cost = buildLevel.cost[resource];
    if (cost) costAdjustments[0][resource] -= cost * cities.length;
  }

  const upkeep = buildLevel.daily_upkeep;
  if (upkeep) {
    for (let hourIndex = buildHours; hourIndex < hoursToSimulate; hourIndex++) {
      for (const resource of RESOURCE_KEYS) {
        const amount = upkeep[resource];
        if (amount) costAdjustments[hourIndex][resource] -= (amount / 24) * cities.length;
      }
    }
  }

  return { country, citySim, costAdjustments, buildHours, buildLevel };
});

const coalitionHourly = Array.from({ length: hoursToSimulate }, (_, index) => {
  const production = zeroProduction();
  for (const sim of countrySimulations) {
    for (const resource of RESOURCE_KEYS) {
      production[resource] += sim.citySim.perHourAggregate[index]?.production[resource] ?? 0;
      production[resource] += sim.costAdjustments[index]?.[resource] ?? 0;
    }
  }
  return { hour: index + 1, production };
});

const mapDaysToReport = truceLengthDays + 1;
const dailyNet = Array.from({ length: mapDaysToReport }, (_, index) => {
  const mapDay = scenario.start.day + index;
  const row: { mapDay: number; hoursCounted: number } & Record<Resource, number> = {
    mapDay,
    hoursCounted: 0,
    ...zeroProduction(),
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
  for (const resource of RESOURCE_KEYS) acc[resource] += row[resource];
  return acc;
}, zeroProduction());

const coalitionCountryCount = coalitionCountries.length;
const startingBalances = Object.fromEntries(
  RESOURCE_KEYS.map(resource => [
    resource,
    (scenario.starting_balance?.[resource] ?? 0) * coalitionCountryCount,
  ])
) as Record<Resource, number>;

const endingBalances = Object.fromEntries(
  RESOURCE_KEYS.map(resource => [resource, startingBalances[resource] + totals[resource]])
) as Record<Resource, number>;

console.log(`Scenario: ${scenario.id} (${scenario.speed}), truce=${truceLengthDays} days`);
console.log(`Coalition: ${coalitionCountries.map(c => `${c.country.name} (${c.cities.length} cities)`).join(", ")}`);
console.log(`\nBuild program: arms_industry level 1 in every city, nothing else.`);
for (const sim of countrySimulations) {
  console.log(
    `- ${sim.country.country.name}: AI1 cost/city=${JSON.stringify(sim.buildLevel.cost)}, build time=${sim.buildHours}h, upkeep/day/city=${JSON.stringify(sim.buildLevel.daily_upkeep ?? {})}`
  );
}
console.log(`\nAssumption: scenario.starting_balance (${JSON.stringify(scenario.starting_balance)}) applied once per coalition country (x${coalitionCountryCount}), matching the convention used by ww3-2026-coalition-eco.ts.`);

console.log("\nTotals over full truce window:");
console.table([
  { label: "Net Production (incl. AI1 cost+upkeep)", ...totals },
  { label: "Starting Balance", ...startingBalances },
  { label: "Ending Balance", ...endingBalances },
]);

console.log("\nDaily net production:");
console.table(dailyNet);
