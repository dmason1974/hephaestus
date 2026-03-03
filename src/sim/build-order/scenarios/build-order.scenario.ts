import path from "node:path";

import { simulateBuildOrder, type CityState } from "../build-order-sim.js";
import { dayStartAbsoluteHour, scenarioStartAbsoluteHour } from "../../../core/time.js";
import { baselineHomelandMoraleOnDay } from "../../../models/morale/morale-baseline.js";
import { moraleProductionMultiplier } from "../../../models/morale/morale-modifier.js";
import { validateBuildingsFile } from "../../../validation/buildingSchema.js";
import { loadScenarioFile } from "../../../validation/scenarioPaths.js";

const scenarioId = "elite_ava_feb_2026";
const scenario = loadScenarioFile(scenarioId);
const buildings = validateBuildingsFile(
  path.join(process.cwd(), "data", "buildings.yml")
);

const city: CityState = {
  cityId: "supplies_city",
  baseHourlyProduction: {
    supplies: 1000,
    components: 0,
    fuel: 0,
    rares: 0,
    electronics: 0,
    cash: 1500,
    manpower: 150,
  },
  buildings: { arms_industry: 0, underground_bunkers: 0 },
};

const result = simulateBuildOrder({
  cities: [city],
  buildOrder: [
    { cityId: "supplies_city", buildingId: "arms_industry", targetLevel: 1 },
    { cityId: "supplies_city", buildingId: "arms_industry", targetLevel: 2 },
    { cityId: "supplies_city", buildingId: "arms_industry", targetLevel: 3 },
    { cityId: "supplies_city", buildingId: "arms_industry", targetLevel: 4 },
    { cityId: "supplies_city", buildingId: "arms_industry", targetLevel: 5 },
  ],
  buildings,
  scenario,
  hoursToSimulate: 180,
});

const debugByHour = new Map(
  (result.debug ?? []).map(entry => [`${entry.cityId}:${entry.hour}`, entry])
);

console.log("Build order smoke: Arms Industry 1 -> 5");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(
  `Scenario start: day ${scenario.start.day}, hour ${scenario.start.hour}, t0=${scenarioStartAbsoluteHour(
    scenario
  )}`
);
console.log("City: supplies_city");

console.log("Build timings:");
console.table(
  (result.timingDebug?.builds ?? []).map(build => ({
    cityId: build.cityId,
    buildingId: build.buildingId,
    fromLevel: build.fromLevel,
    toLevel: build.toLevel,
    start_rel_hour: build.startRelHour,
    duration_hours: build.durationHours,
    completion_abs: build.completionAbs,
    activationDay: build.activationDay,
  }))
);

console.log("Day timings:");
console.table(
  (result.timingDebug?.days ?? []).map(day => ({
    cityId: day.cityId,
    dayIndex: day.dayIndex,
    dayStart_abs: day.dayStartAbs,
    bunkerLevelAtDayStart: day.bunkerLevelAtDayStart,
  }))
);

const initialMultiplier = moraleProductionMultiplier(baselineHomelandMoraleOnDay(1));

const initialRow = {
  hour: 0,
  absoluteHour: scenarioStartAbsoluteHour(scenario),
  dayIndex: 1,
  dayStartAbs: dayStartAbsoluteHour(scenario, 1),
  multiplier: initialMultiplier,
  supplies: Math.round(city.baseHourlyProduction.supplies * initialMultiplier),
  cash: Math.round(city.baseHourlyProduction.cash * initialMultiplier),
  manpower: Math.round(city.baseHourlyProduction.manpower * initialMultiplier),
  fromLevel: 0,
  toLevel: 0,
};

console.table(
  [
    initialRow,
    ...result.perHourPerCity.map(row => {
      const debug = debugByHour.get(`${row.cityId}:${row.hour}`);
      return {
        hour: row.hour + 1,
        absoluteHour: debug?.absoluteHour ?? (scenarioStartAbsoluteHour(scenario) + row.hour),
        dayIndex: debug?.dayIndex ?? Math.floor(row.hour / 24) + 1,
        dayStartAbs:
          debug?.dayStartAbsoluteHour ??
          dayStartAbsoluteHour(scenario, Math.floor(row.hour / 24) + 1),
        multiplier: Number(row.multiplier.toPrecision(3)),
        supplies: Math.round(row.production.supplies),
        cash: Math.round(row.production.cash),
        manpower: Math.round(row.production.manpower),
        fromLevel: debug?.currentFromLevel ?? 0,
        toLevel: debug?.currentToLevel ?? 0,
      };
    }),
  ].map(row => ({
      hour: row.hour,
      absoluteHour: row.absoluteHour,
      dayIndex: row.dayIndex,
      dayStartAbs: row.dayStartAbs,
      multiplier: row.multiplier.toFixed(2),
      supplies: row.supplies,
      cash: row.cash,
      manpower: row.manpower,
      fromLevel: row.fromLevel,
      toLevel: row.toLevel,
    }))
);

console.log(
  "Ending aggregate:",
  (() => {
    const ending = result.perHourAggregate[result.perHourAggregate.length - 1]?.production;
    if (!ending) return undefined;

    return {
      supplies: Math.round(ending.supplies),
      components: Math.round(ending.components),
      fuel: Math.round(ending.fuel),
      rares: Math.round(ending.rares),
      electronics: Math.round(ending.electronics),
      cash: Math.round(ending.cash),
      manpower: Math.round(ending.manpower),
    };
  })()
);
