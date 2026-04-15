import path from "node:path";

import {
  DEFAULT_MORALE_DECAY_D,
  HOMELAND_TARGET_MORALE,
  STARTING_MORALE_DAY1,
  type Resource,
  type StartingPopulation,
} from "../../core/constants.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import { buildTimeToMinutes, scheduleBuildSegments, type BuildAction } from "../../engine/orchestration/build-order-timeline.js";
import { simulateBuildOrder, type CityState } from "../../engine/simulation/build-order-sim.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";

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
const scenario = loadScenarioFile(scenarioId);
const buildings = loadBuildingsFile(path.resolve("data/buildings.yml"));
const greece = loadScenarioCountry(scenarioId, "greece");
const cityData = greece.cities.find(city => city.id === "thessaloniki");

if (!cityData) {
  throw new Error("Missing thessaloniki in Greece data");
}

const hoursToSimulate = 28 * 24;
const occupationAbsoluteHour = ((3 - 1) * 24) + 0;
const occupationStartHour = occupationAbsoluteHour - scenarioStartAbsoluteHour(scenario);

function mapDayForAbsoluteHour(absoluteHour: number) {
  return Math.floor(absoluteHour / 24) + 1;
}

function hourOfDayForAbsoluteHour(absoluteHour: number) {
  return (absoluteHour % 24) + 1;
}

function zeroResources() {
  return {
    supplies: 0,
    components: 0,
    fuel: 0,
    rares: 0,
    electronics: 0,
    cash: 0,
    manpower: 0,
  } satisfies Record<Resource, number>;
}

function levelCost(buildingId: BuildAction["buildingId"], level: number) {
  const data = buildings.buildings[buildingId]?.levels[String(level) as "1" | "2" | "3" | "4" | "5"];
  if (!data) {
    throw new Error(`Missing ${buildingId} level ${level}`);
  }
  return data;
}

function hourlyNetAdjustments(
  city: CityState,
  buildOrder: BuildAction[]
) {
  const segmentsByCity = scheduleBuildSegments({
    cities: [{
      cityId: city.cityId,
      countryId: city.countryId,
      capital: city.capital,
      cityStatus: city.cityStatus,
      moraleParams: city.moraleParams,
      buildings: city.buildings,
    }],
    buildOrder,
    buildings,
    scenario,
  });

  const adjustments = Array.from({ length: hoursToSimulate }, () => zeroResources());
  const segments = segmentsByCity.get(city.cityId);
  if (!segments) {
    throw new Error(`Missing segments for ${city.cityId}`);
  }

  for (const [buildingId, buildingSegments] of Object.entries(segments) as Array<[BuildAction["buildingId"], typeof segments[BuildAction["buildingId"]]]>) {
    for (const segment of buildingSegments) {
      const startHourIndex = Math.floor(segment.startMinute / 60) - scenarioStartAbsoluteHour(scenario);
      if (startHourIndex >= 0 && startHourIndex < hoursToSimulate) {
        const cost = levelCost(buildingId, segment.toLevel).cost;
        for (const resource of RESOURCE_KEYS) {
          adjustments[startHourIndex][resource] -= cost[resource];
        }
      }

      const upkeep = levelCost(buildingId, segment.toLevel).daily_upkeep;
      if (!upkeep) continue;

      const completionHourIndex = Math.ceil(segment.endMinute / 60) - scenarioStartAbsoluteHour(scenario);
      for (let hourIndex = completionHourIndex; hourIndex < hoursToSimulate; hourIndex++) {
        for (const resource of RESOURCE_KEYS) {
          const amount = upkeep[resource];
          if (!Number.isFinite(amount ?? NaN)) continue;
          adjustments[hourIndex][resource] -= Math.floor((amount ?? 0) / 24);
        }
      }
    }
  }

  return { adjustments, segments };
}

const city: CityState = {
  cityId: "greece:thessaloniki",
  countryId: "greece",
  capital: cityData.capital,
  resource: "electronics",
  startPop: cityData.population as StartingPopulation,
  cityStatus: "occupied",
  moraleParams: {
    S: STARTING_MORALE_DAY1,
    T: HOMELAND_TARGET_MORALE,
    N: 0,
    D: DEFAULT_MORALE_DECAY_D,
  },
  buildings: {
    air_base: cityData.starting.air_base,
    annex_city: 0,
    arms_industry: 0,
    combat_outpost: 0,
    local_industry: 0,
    naval_base: cityData.starting.naval_base,
    recruiting_office: 0,
    relocate_headquarters: 0,
    underground_bunkers: cityData.starting.underground_bunkers,
  },
};

const buildOrder: BuildAction[] = [
  { cityId: city.cityId, buildingId: "recruiting_office", targetLevel: 1, startHour: occupationStartHour },
  { cityId: city.cityId, buildingId: "annex_city", targetLevel: 1, startHour: occupationStartHour },
  { cityId: city.cityId, buildingId: "arms_industry", targetLevel: 1, startHour: occupationStartHour },
  { cityId: city.cityId, buildingId: "underground_bunkers", targetLevel: 3, startHour: occupationStartHour },
  { cityId: city.cityId, buildingId: "arms_industry", targetLevel: 5, startHour: occupationStartHour },
];

const baseline = simulateBuildOrder({
  cities: [city],
  buildOrder: [],
  buildings,
  scenario,
  hoursToSimulate,
});
const planned = simulateBuildOrder({
  cities: [city],
  buildOrder,
  buildings,
  scenario,
  hoursToSimulate,
});
const { adjustments, segments } = hourlyNetAdjustments(city, buildOrder);

const grossDelta = zeroResources();
const netDelta = zeroResources();
const rollingNet = zeroResources();
let firstPositiveHour: { absoluteHour: number; mapDay: number; hourOfDay: number } | undefined;

for (let index = 0; index < hoursToSimulate; index++) {
  for (const resource of RESOURCE_KEYS) {
    const baselineValue = baseline.perHourAggregate[index]?.production[resource] ?? 0;
    const plannedValue = planned.perHourAggregate[index]?.production[resource] ?? 0;
    const hourGrossDelta = plannedValue - baselineValue;
    const hourNetDelta = hourGrossDelta + adjustments[index][resource];

    grossDelta[resource] += hourGrossDelta;
    netDelta[resource] += hourNetDelta;
    rollingNet[resource] += hourNetDelta;
  }

  if (!firstPositiveHour && rollingNet.electronics > 0) {
    const absoluteHour = scenarioStartAbsoluteHour(scenario) + index;
    firstPositiveHour = {
      absoluteHour,
      mapDay: mapDayForAbsoluteHour(absoluteHour),
      hourOfDay: hourOfDayForAbsoluteHour(absoluteHour),
    };
  }
}

const buildTimings = Object.entries(segments)
  .flatMap(([, buildingSegments]) => buildingSegments)
  .map(segment => ({
    buildingId: segment.buildingId,
    fromLevel: segment.fromLevel,
    toLevel: segment.toLevel,
    startDay: mapDayForAbsoluteHour(segment.startMinute / 60),
    startHour: hourOfDayForAbsoluteHour(segment.startMinute / 60),
    endDay: mapDayForAbsoluteHour(segment.endMinute / 60),
    endHour: hourOfDayForAbsoluteHour(segment.endMinute / 60),
    durationHours: Number(((segment.endMinute - segment.startMinute) / 60).toFixed(2)),
  }));

const endBalances = Array.from({ length: 29 }, (_, index) => {
  const mapDay = scenario.start.day + index;
  const endHourAbsolute = (mapDay * 24) - 1;
  const rowIndex = endHourAbsolute - scenarioStartAbsoluteHour(scenario);
  const plannedProd = zeroResources();
  const baselineProd = zeroResources();
  const netDiff = zeroResources();

  for (let i = 0; i <= Math.min(rowIndex, hoursToSimulate - 1); i++) {
    for (const resource of RESOURCE_KEYS) {
      plannedProd[resource] += planned.perHourAggregate[i]?.production[resource] ?? 0;
      baselineProd[resource] += baseline.perHourAggregate[i]?.production[resource] ?? 0;
      netDiff[resource] += (planned.perHourAggregate[i]?.production[resource] ?? 0) -
        (baseline.perHourAggregate[i]?.production[resource] ?? 0) +
        adjustments[i][resource];
    }
  }

  return {
    mapDay,
    electronicsGrossGain: plannedProd.electronics - baselineProd.electronics,
    cashGrossGain: plannedProd.cash - baselineProd.cash,
    manpowerGrossGain: plannedProd.manpower - baselineProd.manpower,
    electronicsNet: netDiff.electronics,
    cashNet: netDiff.cash,
    manpowerNet: netDiff.manpower,
  };
});

console.log("Greece electronics city benefit smoke");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log("City: greece:thessaloniki");
console.log("Sequence:");
console.log("- recruiting_office level 1");
console.log("- annex_city level 1");
console.log("- arms_industry level 1");
console.log("- underground_bunkers level 3");
console.log("- arms_industry level 5");
console.log(`Occupation starts: map day ${mapDayForAbsoluteHour(occupationAbsoluteHour)}, hour ${hourOfDayForAbsoluteHour(occupationAbsoluteHour)}`);
console.log(`Build queue starts at relative hour ${occupationStartHour}`);
console.log("Build timings:");
console.table(buildTimings);
console.log("Total gross production lift over baseline occupied city:");
console.table([grossDelta]);
console.log("Total net effect after build costs and upkeep over the 28-day window:");
console.table([netDelta]);
console.log("End-of-day cumulative electronics/cash/manpower deltas:");
console.table(endBalances);
console.log("First hour cumulative net electronics turns positive:", firstPositiveHour ?? "not within window");
