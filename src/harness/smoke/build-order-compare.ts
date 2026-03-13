import path from "node:path";

import { type Resource } from "../../core/constants.js";
import { toAbsoluteHour } from "../../core/time.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import {
  simulateBuildOrder,
  type BuildAction,
  type CityState,
} from "../../engine/simulation/build-order-sim.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";

const scenarioId = "elite_ava_feb_2026";
const countryId = "argentina";
const cityId = "buenos_aires";
const mapDaysToCompare = 28;

const scenario = loadScenarioFile(scenarioId);
const country = loadScenarioCountry(scenarioId, countryId);
const buildings = loadBuildingsFile(path.join(process.cwd(), "data", "buildings.yml"));
const sourceCity = country.cities.find(city => city.id === cityId);

if (!sourceCity) {
  throw new Error(`city "${cityId}" was not found in ${countryId}`);
}

const producedResource = sourceCity.resource as Exclude<Resource, "cash" | "manpower">;
const totalHours = toAbsoluteHour(mapDaysToCompare, 24) - toAbsoluteHour(scenario.start.day, scenario.start.hour) + 1;

function buildBaselineCityState(): CityState {
  return {
    cityId: sourceCity.id,
    resource: producedResource,
    startPop: sourceCity.population as CityState["startPop"],
    buildings: {
      air_base: sourceCity.starting.air_base,
      annex_city: 0,
      arms_industry: sourceCity.starting.arms_industry,
      naval_base: sourceCity.starting.naval_base,
      relocate_headquarters: 0,
      underground_bunkers: 0,
    },
  };
}

function cumulativeByMapDay(result: ReturnType<typeof simulateBuildOrder>) {
  let resourceRunning = 0;
  let cashRunning = 0;
  const byDay = new Map<number, { resourceDay: number; cashDay: number }>();
  const scenarioStartAbsoluteHour = toAbsoluteHour(scenario.start.day, scenario.start.hour);

  for (const row of result.perHourAggregate) {
    const absoluteHour = scenarioStartAbsoluteHour + row.hour;
    const mapDay = Math.floor(absoluteHour / 24) + 1;
    const current = byDay.get(mapDay) ?? { resourceDay: 0, cashDay: 0 };
    current.resourceDay += row.production[producedResource];
    current.cashDay += row.production.cash;
    byDay.set(mapDay, current);
  }

  return Array.from({ length: mapDaysToCompare }, (_, index) => {
    const day = index + 1;
    const current = byDay.get(day) ?? { resourceDay: 0, cashDay: 0 };
    resourceRunning += current.resourceDay;
    cashRunning += current.cashDay;

    return {
      day,
      resourceDay: Math.round(current.resourceDay),
      cashDay: Math.round(current.cashDay),
      resourceCum: Math.round(resourceRunning),
      cashCum: Math.round(cashRunning),
    };
  });
}

const aiThenBunkers: BuildAction[] = [
  { cityId, buildingId: "arms_industry", targetLevel: 5 },
  { cityId, buildingId: "underground_bunkers", targetLevel: 3 },
];

const bunkersThenAi: BuildAction[] = [
  { cityId, buildingId: "underground_bunkers", targetLevel: 3 },
  { cityId, buildingId: "arms_industry", targetLevel: 5 },
];

const aiFirstResult = simulateBuildOrder({
  cities: [buildBaselineCityState()],
  buildOrder: aiThenBunkers,
  buildings,
  scenario,
  hoursToSimulate: totalHours,
});

const bunkerFirstResult = simulateBuildOrder({
  cities: [buildBaselineCityState()],
  buildOrder: bunkersThenAi,
  buildings,
  scenario,
  hoursToSimulate: totalHours,
});

const aiFirstByDay = cumulativeByMapDay(aiFirstResult);
const bunkerFirstByDay = cumulativeByMapDay(bunkerFirstResult);
const aiFirstFinal = aiFirstByDay[aiFirstByDay.length - 1];
const bunkerFirstFinal = bunkerFirstByDay[bunkerFirstByDay.length - 1];

console.log("Build order comparison smoke");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(`Country: ${country.country.name}`);
console.log(
  `City: ${sourceCity.name} (${producedResource}, pop ${sourceCity.population}, start day ${scenario.start.day} hour ${scenario.start.hour})`
);
console.log(
  "Assumption: this comparison uses the shared city-production model with dynamic building state from the build-order sim."
);

console.log("Build timings:");
console.table([
  ...((aiFirstResult.timingDebug?.builds ?? []).map(build => ({
    order: "AI5 -> B3",
    buildingId: build.buildingId,
    fromLevel: build.fromLevel,
    toLevel: build.toLevel,
    startRelHour: Number(build.startRelHour.toFixed(2)),
    durationHours: Number(build.durationHours.toFixed(2)),
    completionAbs: Number(build.completionAbs.toFixed(2)),
    activationDay: build.activationDay,
  }))),
  ...((bunkerFirstResult.timingDebug?.builds ?? []).map(build => ({
    order: "B3 -> AI5",
    buildingId: build.buildingId,
    fromLevel: build.fromLevel,
    toLevel: build.toLevel,
    startRelHour: Number(build.startRelHour.toFixed(2)),
    durationHours: Number(build.durationHours.toFixed(2)),
    completionAbs: Number(build.completionAbs.toFixed(2)),
    activationDay: build.activationDay,
  }))),
]);

console.log(`Cumulative output through map day ${mapDaysToCompare}:`);
console.table([
  {
    order: "AI5 -> B3",
    [producedResource]: aiFirstFinal.resourceCum,
    cash: aiFirstFinal.cashCum,
  },
  {
    order: "B3 -> AI5",
    [producedResource]: bunkerFirstFinal.resourceCum,
    cash: bunkerFirstFinal.cashCum,
  },
  {
    order: "Delta (AI5 -> B3 minus B3 -> AI5)",
    [producedResource]: aiFirstFinal.resourceCum - bunkerFirstFinal.resourceCum,
    cash: aiFirstFinal.cashCum - bunkerFirstFinal.cashCum,
  },
]);

console.log("Daily cumulative comparison:");
console.table(
  aiFirstByDay.map((row, index) => ({
    day: row.day,
    aiFirstResourceCum: row.resourceCum,
    bunkerFirstResourceCum: bunkerFirstByDay[index].resourceCum,
    resourceDelta: row.resourceCum - bunkerFirstByDay[index].resourceCum,
    aiFirstCashCum: row.cashCum,
    bunkerFirstCashCum: bunkerFirstByDay[index].cashCum,
    cashDelta: row.cashCum - bunkerFirstByDay[index].cashCum,
  }))
);
