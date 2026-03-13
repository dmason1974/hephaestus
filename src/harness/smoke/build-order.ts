import path from "node:path";

import {
  DEFAULT_MORALE_DECAY_D,
  HOMELAND_TARGET_MORALE,
  STARTING_MORALE_DAY1,
} from "../../core/constants.js";
import { simulateBuildOrder, type CityState } from "../../engine/simulation/build-order-sim.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import {
  baselineHomelandMoraleOnDay,
  homelandMoraleOnDayWithBunkers,
  moraleProductionMultiplier,
} from "../../engine/economy/morale.js";
import { hourlyResourcePointAtAbsoluteHour } from "../../engine/economy/city-production.js";
import { getEconomicBuildingEffectsForLevels } from "../../engine/economy/building-modifiers.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";

const scenarioId = "elite_ava_feb_2026";
const scenario = loadScenarioFile(scenarioId);
const buildings = loadBuildingsFile(
  path.join(process.cwd(), "data", "buildings.yml")
);

const city: CityState = {
  cityId: "supplies_city",
  resource: "supplies",
  startPop: 6,
  buildings: {
    air_base: 0,
    annex_city: 0,
    arms_industry: 0,
    naval_base: 0,
    relocate_headquarters: 0,
    underground_bunkers: 0,
  },
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

const initialAbsoluteHour = scenarioStartAbsoluteHour(scenario);
const initialMapDay = Math.floor(initialAbsoluteHour / 24) + 1;
const initialBaseEffects = getEconomicBuildingEffectsForLevels(buildings, city.buildings);
const initialMultiplier = moraleProductionMultiplier(baselineHomelandMoraleOnDay(initialMapDay));

const initialRow = {
  hour: 0,
  absoluteHour: initialAbsoluteHour,
  dayIndex: initialMapDay,
  dayStartAbs: Math.floor(initialAbsoluteHour / 24) * 24,
  morale: baselineHomelandMoraleOnDay(initialMapDay),
  multiplier: initialMultiplier,
  supplies: hourlyResourcePointAtAbsoluteHour(
    scenario.speed,
    {
      resource: "supplies",
      startPop: city.startPop,
      moraleParams: {
        S: STARTING_MORALE_DAY1,
        T: HOMELAND_TARGET_MORALE,
        N: initialBaseEffects.moraleBonusN,
        D: DEFAULT_MORALE_DECAY_D,
      },
      buildingEffects: initialBaseEffects,
    },
    initialAbsoluteHour
  ).amount,
  cash: hourlyResourcePointAtAbsoluteHour(
    scenario.speed,
    {
      resource: "cash",
      startPop: city.startPop,
      moraleParams: {
        S: STARTING_MORALE_DAY1,
        T: HOMELAND_TARGET_MORALE,
        N: initialBaseEffects.moraleBonusN,
        D: DEFAULT_MORALE_DECAY_D,
      },
      buildingEffects: initialBaseEffects,
    },
    initialAbsoluteHour
  ).amount,
  manpower: hourlyResourcePointAtAbsoluteHour(
    scenario.speed,
    {
      resource: "manpower",
      startPop: city.startPop,
      moraleParams: {
        S: STARTING_MORALE_DAY1,
        T: HOMELAND_TARGET_MORALE,
        N: initialBaseEffects.moraleBonusN,
        D: DEFAULT_MORALE_DECAY_D,
      },
      buildingEffects: initialBaseEffects,
    },
    initialAbsoluteHour
  ).amount,
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
        dayIndex:
          debug?.dayIndex ??
          (Math.floor((scenarioStartAbsoluteHour(scenario) + row.hour) / 24) + 1),
        dayStartAbs:
          debug?.dayStartAbsoluteHour ??
          (Math.floor((scenarioStartAbsoluteHour(scenario) + row.hour) / 24) * 24),
        morale: homelandMoraleOnDayWithBunkers(
          debug?.dayIndex ??
            (Math.floor((scenarioStartAbsoluteHour(scenario) + row.hour) / 24) + 1),
          debug?.bunkerLevelAtDayStart ?? 0,
          buildings
        ),
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
      morale: row.morale,
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
