import fs from "node:fs";
import path from "node:path";

import type { Resource, StartingPopulation } from "../../core/constants.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import {
  scheduleBuildSegments,
  type BuildAction,
} from "../../engine/orchestration/build-order-timeline.js";
import { buildCountryHourlyResourceBalanceTable } from "../../engine/reporting/country-resource-balance.js";
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

const BUILDING_LABELS = {
  annex_city: "annex_city",
  air_base: "air_base",
  arms_industry: "arms_industry",
  military_hospital: "military_hospital",
  naval_base: "naval_base",
  relocate_headquarters: "relocate_headquarters",
  underground_bunkers: "underground_bunkers",
} as const;

type CandidateBuildingId = keyof typeof BUILDING_LABELS;
type TokenAction = { buildingId: CandidateBuildingId; targetLevel: number };
type Evaluation = {
  feasible: boolean;
  timedOrder: BuildAction[];
  balancesByHour: Array<Record<Resource, number>>;
  endingBalances: Record<Resource, number>;
  nextFreeRelHour: number;
};
type RankedSequence = {
  sequenceLines: string[];
  timedOrderLines: string[];
  deltaResource: number;
  endResource: number;
  endCash: number;
  endManpower: number;
};
type CandidatePlan = {
  tokens: TokenAction[];
  evaluation: Evaluation;
  ranked: RankedSequence;
};

const scenarioId = process.env.OCB_SCENARIO?.trim() || "elite/ww3";
const ownerCountryId = process.env.OCB_OWNER_COUNTRY?.trim() || "indonesia";
const occupiedCountryId = process.env.OCB_OCCUPIED_COUNTRY?.trim() || "philippines";
const cityFilter = process.env.OCB_CITY_IDS?.trim() || "davao,cebu";
const beamWidth = parsePositiveInt(process.env.OCB_WIDTH, 300);
const topN = parsePositiveInt(process.env.OCB_TOP, 1);
const daysToSimulate = parsePositiveInt(process.env.OCB_DAYS, 28);
const occupationDay = parsePositiveNumber(process.env.OCB_OCCUPATION_DAY, 4);
const outputFilePath = path.resolve(process.env.OCB_OUTPUT_FILE?.trim() || "tmp/occupied-city-target-beam.html");
const hoursToSimulate = daysToSimulate * 24;

const scenario = loadScenarioFile(scenarioId);
const buildings = loadBuildingsFile(path.resolve("data/buildings.yml"));
const ownerCountry = loadScenarioCountry(scenarioId, ownerCountryId);
const occupiedCountry = loadScenarioCountry(scenarioId, occupiedCountryId);
const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
const occupationStartAbsHour = ((occupationDay - 1) * 24);
const selectedCityIds = cityFilter.split(",").map(part => part.trim()).filter(Boolean);

function parsePositiveInt(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveNumber(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function htmlList(lines: string[]) {
  if (lines.length === 0) return "<p><em>None</em></p>";
  return `<ul>${lines.map(line => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`;
}

function buildHomelandCityState(city: typeof ownerCountry.cities[number]): CityState {
  return {
    cityId: `${ownerCountry.country.id}:${city.id}`,
    countryId: ownerCountry.country.id,
    capital: city.capital,
    resource: city.resource,
    startPop: city.population as StartingPopulation,
    cityStatus: "homeland",
    buildings: {
      army_base: city.starting.army_base,
      air_base: city.starting.air_base,
      annex_city: 0,
      arms_industry: city.starting.arms_industry,
      combat_outpost: 0,
      local_industry: 0,
      military_hospital: 0,
      naval_base: city.starting.naval_base,
      recruiting_office: city.starting.recruiting_office,
      relocate_headquarters: 0,
      underground_bunkers: city.starting.underground_bunkers,
    },
  };
}

function buildOccupiedCityState(city: typeof occupiedCountry.cities[number]): CityState {
  return {
    cityId: `${occupiedCountry.country.id}:${city.id}`,
    countryId: occupiedCountry.country.id,
    capital: city.capital,
    resource: city.resource,
    startPop: city.population as StartingPopulation,
    cityStatus: "occupied",
    buildings: {
      army_base: city.starting.army_base,
      air_base: city.starting.air_base,
      annex_city: 0,
      arms_industry: city.starting.arms_industry,
      combat_outpost: 0,
      local_industry: 0,
      military_hospital: 0,
      naval_base: city.starting.naval_base,
      recruiting_office: city.starting.recruiting_office,
      relocate_headquarters: 0,
      underground_bunkers: city.starting.underground_bunkers,
    },
  };
}

function hourlyDeltasFromCountryTable(table: ReturnType<typeof buildCountryHourlyResourceBalanceTable>, firstPrevious: Partial<Record<Resource, number>>) {
  return table.rows.map((row, index) => {
    const previous = index === 0 ? firstPrevious : table.rows[index - 1]?.balances;
    const delta = zeroResources();
    for (const resource of RESOURCE_KEYS) {
      delta[resource] = (row.balances[resource] ?? 0) - (previous?.[resource] ?? 0);
    }
    return delta;
  }).slice(0, hoursToSimulate);
}

function levelData(buildingId: CandidateBuildingId, level: number) {
  const data = buildings.buildings[buildingId]?.levels[String(level) as "1" | "2" | "3" | "4" | "5"];
  if (!data) throw new Error(`Missing ${buildingId} level ${level}`);
  return data;
}

function maxDefinedLevel(buildingId: CandidateBuildingId) {
  const levels = Object.entries(buildings.buildings[buildingId]?.levels ?? {})
    .filter(([, value]) => value)
    .map(([level]) => Number(level));
  return levels.length > 0 ? Math.max(...levels) : 0;
}

function cityLevelForTokens(
  city: typeof occupiedCountry.cities[number],
  tokens: TokenAction[],
  buildingId: CandidateBuildingId
) {
  const startingLevel =
    buildingId === "air_base"
      ? city.starting.air_base
      : buildingId === "naval_base"
        ? city.starting.naval_base
        : buildingId === "underground_bunkers"
          ? city.starting.underground_bunkers
          : 0;
  return startingLevel + tokens.filter(token => token.buildingId === buildingId).length;
}

function buildingPoolForCity(city: typeof occupiedCountry.cities[number]): CandidateBuildingId[] {
  const pool: CandidateBuildingId[] = ["annex_city", "arms_industry", "air_base", "military_hospital", "underground_bunkers"];
  if (city.starting.naval_base >= 1) pool.push("naval_base");
  return pool;
}

function maxSequenceLength(city: typeof occupiedCountry.cities[number], pool: CandidateBuildingId[]) {
  return pool.reduce((sum, buildingId) => sum + (maxDefinedLevel(buildingId) - cityLevelForTokens(city, [], buildingId)), 0);
}

function tokenSequenceKey(tokens: TokenAction[]) {
  return tokens.map(token => `${token.buildingId}:${token.targetLevel}`).join("|");
}

function formatTimedOrderLines(actions: BuildAction[]) {
  if (actions.length === 0) return ["(no build)"];
  return actions.map(
    (action, index) =>
      `${index + 1}. ${BUILDING_LABELS[action.buildingId as CandidateBuildingId]} level ${action.targetLevel} at hour ${action.startHour ?? 0}`
  );
}

function compareRanked(a: RankedSequence, b: RankedSequence) {
  return (b.endResource - a.endResource) || a.sequenceLines.join("|").localeCompare(b.sequenceLines.join("|"));
}

const ownerTable = buildCountryHourlyResourceBalanceTable(
  ownerCountry,
  daysToSimulate,
  scenario.speed,
  {
    buildingsFile: buildings,
    scenario,
    startingBalances: scenario.starting_balance,
    startAbsoluteHour: scenarioAbsHour,
    cityDefaults: { cityStatus: "homeland" },
    provinceDefaults: { cityStatus: "homeland", localIndustryLevel: 3, combatOutpostLevel: 1 },
  }
);
const occupiedScenario = {
  ...scenario,
  city_statuses: {
    ...(scenario.city_statuses ?? {}),
    [occupiedCountry.country.id]: Object.fromEntries(occupiedCountry.cities.map(city => [city.id, "occupied" as const])),
  },
};
const occupiedTable = buildCountryHourlyResourceBalanceTable(
  occupiedCountry,
  daysToSimulate,
  scenario.speed,
  {
    buildingsFile: buildings,
    scenario: occupiedScenario,
    startAbsoluteHour: scenarioAbsHour,
    cityDefaults: { cityStatus: "occupied" },
    provinceDefaults: { cityStatus: "occupied" },
  }
);

const ownerHourly = hourlyDeltasFromCountryTable(ownerTable, scenario.starting_balance);
const occupiedHourly = hourlyDeltasFromCountryTable(occupiedTable, zeroResources());

function evaluateTimedOrder(
  cityState: CityState,
  otherCountryHourly: Array<Record<Resource, number>>,
  timedOrder: BuildAction[]
): Evaluation {
  const simulation = simulateBuildOrder({
    cities: [cityState],
    buildOrder: timedOrder,
    buildings,
    scenario,
    hoursToSimulate,
  });

  const segmentsByCity = scheduleBuildSegments({
    cities: [{
      cityId: cityState.cityId,
      countryId: cityState.countryId,
      capital: cityState.capital,
      cityStatus: cityState.cityStatus,
      moraleParams: cityState.moraleParams,
      buildings: cityState.buildings,
    }],
    buildOrder: timedOrder,
    buildings,
    scenario,
  });

  const adjustments = Array.from({ length: hoursToSimulate }, () => zeroResources());
  const segments = segmentsByCity.get(cityState.cityId);
  if (!segments) throw new Error(`Missing build segments for ${cityState.cityId}`);

  for (const [buildingId, buildingSegments] of Object.entries(segments) as Array<[CandidateBuildingId, typeof segments[CandidateBuildingId]]>) {
    for (const segment of buildingSegments) {
      const cost = levelData(buildingId, segment.toLevel).cost;
      const startHourIndex = Math.floor(segment.startMinute / 60) - scenarioAbsHour;
      if (startHourIndex >= 0 && startHourIndex < hoursToSimulate) {
        for (const resource of RESOURCE_KEYS) adjustments[startHourIndex][resource] -= cost[resource];
      }
      const upkeep = levelData(buildingId, segment.toLevel).daily_upkeep;
      if (!upkeep) continue;
      const completionHourIndex = Math.ceil(segment.endMinute / 60) - scenarioAbsHour;
      for (let hourIndex = completionHourIndex; hourIndex < hoursToSimulate; hourIndex++) {
        for (const resource of RESOURCE_KEYS) {
          const amount = upkeep[resource];
          if (Number.isFinite(amount ?? NaN)) adjustments[hourIndex][resource] -= Math.floor((amount ?? 0) / 24);
        }
      }
    }
  }

  const balancesByHour: Array<Record<Resource, number>> = [];
  const endingBalances = zeroResources();
  for (let hourIndex = 0; hourIndex < hoursToSimulate; hourIndex++) {
    const previous = balancesByHour[hourIndex - 1] ?? ({
      supplies: Math.floor(scenario.starting_balance.supplies ?? 0),
      components: Math.floor(scenario.starting_balance.components ?? 0),
      fuel: Math.floor(scenario.starting_balance.fuel ?? 0),
      rares: Math.floor(scenario.starting_balance.rares ?? 0),
      electronics: Math.floor(scenario.starting_balance.electronics ?? 0),
      cash: Math.floor(scenario.starting_balance.cash ?? 0),
      manpower: Math.floor(scenario.starting_balance.manpower ?? 0),
    } satisfies Record<Resource, number>);
    const balances = zeroResources();
    for (const resource of RESOURCE_KEYS) {
      const production = (simulation.perHourAggregate[hourIndex]?.production[resource] ?? 0) + (otherCountryHourly[hourIndex]?.[resource] ?? 0);
      balances[resource] = previous[resource] + production + adjustments[hourIndex][resource];
      endingBalances[resource] = balances[resource];
    }
    balancesByHour.push(balances);
  }

  const lastCompletionAbsHour = Object.values(segments)
    .flatMap(buildingSegments => buildingSegments)
    .reduce((latest, segment) => Math.max(latest, segment.endMinute / 60), scenarioAbsHour);

  return {
    feasible: balancesByHour.every(balance => RESOURCE_KEYS.every(resource => balance[resource] >= 0)),
    timedOrder,
    balancesByHour,
    endingBalances,
    nextFreeRelHour: lastCompletionAbsHour - scenarioAbsHour,
  };
}

function beamSearchCity(city: typeof occupiedCountry.cities[number]) {
  const cityState = buildOccupiedCityState(city);

  const homelandCityStateIds = new Set([city.id]);
  const ownerCityStates = ownerCountry.cities.map(buildHomelandCityState);
  const ownerBaselineSimulation = simulateBuildOrder({
    cities: ownerCityStates,
    buildOrder: [],
    buildings,
    scenario,
    hoursToSimulate,
  });
  const occupiedBaselineSimulation = simulateBuildOrder({
    cities: [cityState],
    buildOrder: [],
    buildings,
    scenario,
    hoursToSimulate,
  });

  const otherCountryHourly = ownerHourly.map((ownerRow, index) => {
    const row = zeroResources();
    for (const resource of RESOURCE_KEYS) {
      const ownerContribution = ownerRow[resource] - (ownerBaselineSimulation.perHourAggregate[index]?.production[resource] ?? 0);
      const occupiedContribution =
        (scenarioAbsHour + index) >= occupationStartAbsHour
          ? (occupiedHourly[index]?.[resource] ?? 0) - (occupiedBaselineSimulation.perHourAggregate[index]?.production[resource] ?? 0)
          : 0;
      row[resource] = ownerContribution + occupiedContribution;
    }
    return row;
  });

  const baseline = evaluateTimedOrder(cityState, otherCountryHourly, []);
  const pool = buildingPoolForCity(city);

  function rank(tokens: TokenAction[], evaluation: Evaluation): RankedSequence {
    return {
      sequenceLines: tokens.map((token, index) => `${index + 1}. ${BUILDING_LABELS[token.buildingId]} level ${token.targetLevel}`),
      timedOrderLines: formatTimedOrderLines(evaluation.timedOrder),
      deltaResource: evaluation.endingBalances[city.resource] - baseline.endingBalances[city.resource],
      endResource: evaluation.endingBalances[city.resource],
      endCash: evaluation.endingBalances.cash,
      endManpower: evaluation.endingBalances.manpower,
    };
  }

  const cache = new Map<string, Evaluation>();
  cache.set("", baseline);

  function evaluateTokens(tokens: TokenAction[]) {
    const key = tokenSequenceKey(tokens);
    const cached = cache.get(key);
    if (cached) return cached;

    let timedOrder: BuildAction[] = [];
    let currentEvaluation = baseline;
    const currentTokens: TokenAction[] = [];

    for (const token of tokens) {
      currentTokens.push(token);
      const prefixKey = tokenSequenceKey(currentTokens);
      const prefixCached = cache.get(prefixKey);
      if (prefixCached) {
        timedOrder = prefixCached.timedOrder;
        currentEvaluation = prefixCached;
        continue;
      }

      const minStartHour = Math.max(Math.ceil(currentEvaluation.nextFreeRelHour), Math.ceil(occupationStartAbsHour - scenarioAbsHour));
      const cost = levelData(token.buildingId, token.targetLevel).cost;
      let scheduledStartHour: number | undefined;
      for (let hour = minStartHour; hour < hoursToSimulate; hour++) {
        const available = currentEvaluation.balancesByHour[hour] ?? zeroResources();
        if (RESOURCE_KEYS.every(resource => available[resource] >= cost[resource])) {
          scheduledStartHour = hour;
          break;
        }
      }
      if (scheduledStartHour === undefined) {
        const failed: Evaluation = {
          feasible: false,
          timedOrder,
          balancesByHour: currentEvaluation.balancesByHour,
          endingBalances: currentEvaluation.endingBalances,
          nextFreeRelHour: currentEvaluation.nextFreeRelHour,
        };
        cache.set(prefixKey, failed);
        return failed;
      }

      timedOrder = [...timedOrder, {
        cityId: cityState.cityId,
        buildingId: token.buildingId,
        targetLevel: token.targetLevel,
        startHour: scheduledStartHour,
      }];
      currentEvaluation = evaluateTimedOrder(cityState, otherCountryHourly, timedOrder);
      cache.set(prefixKey, currentEvaluation);
    }
    return currentEvaluation;
  }

  function nextActions(tokens: TokenAction[]) {
    return pool.flatMap(buildingId => {
      const currentLevel = cityLevelForTokens(city, tokens, buildingId);
      if (currentLevel >= maxDefinedLevel(buildingId)) return [];
      return [{ buildingId, targetLevel: currentLevel + 1 } satisfies TokenAction];
    });
  }

  let frontier: CandidatePlan[] = [{ tokens: [], evaluation: baseline, ranked: rank([], baseline) }];
  const allRanked = new Map<string, CandidatePlan>();
  const totalDepth = maxSequenceLength(city, pool);

  for (let depth = 1; depth <= totalDepth; depth++) {
    const candidates = new Map<string, CandidatePlan>();
    for (const plan of frontier) {
      for (const action of nextActions(plan.tokens)) {
        const tokens = [...plan.tokens, action];
        const evaluation = evaluateTokens(tokens);
        if (!evaluation.feasible) continue;
        const key = tokenSequenceKey(tokens);
        const candidate = { tokens, evaluation, ranked: rank(tokens, evaluation) };
        candidates.set(key, candidate);
        allRanked.set(key, candidate);
      }
    }
    if (candidates.size === 0) break;
    frontier = Array.from(candidates.values()).sort((a, b) => compareRanked(a.ranked, b.ranked)).slice(0, beamWidth);
  }

  const top = Array.from(allRanked.values()).sort((a, b) => compareRanked(a.ranked, b.ranked)).slice(0, topN);
  return { city, top };
}

const selectedCities = occupiedCountry.cities.filter(city => selectedCityIds.includes(city.id));
if (selectedCities.length === 0) throw new Error(`No cities matched OCB_CITY_IDS=${cityFilter}`);

const results = selectedCities.map(beamSearchCity);
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Occupied City Target Beam</title><style>
body{font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.4;padding:24px;max-width:1200px;margin:0 auto}
h1,h2,h3{margin:20px 0 8px}
ul{margin:8px 0 20px}
</style></head><body>
<h1>Occupied City Target Beam</h1>
<p>Scenario: ${escapeHtml(`${scenario.id} (${scenario.speed})`)}</p>
<p>Owner: ${escapeHtml(ownerCountry.country.name)} | Occupied: ${escapeHtml(occupiedCountry.country.name)} | Occupation day: ${occupationDay}</p>
${results.map(result => `<h2>${escapeHtml(result.city.name)}</h2><h3>Best Timed Order</h3>${htmlList(result.top[0]?.ranked.timedOrderLines ?? ["(none)"])}`).join("")}
</body></html>`;

fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
fs.writeFileSync(outputFilePath, html, "utf8");

console.log("Occupied city target beam");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(`Owner country: ${ownerCountry.country.name}`);
console.log(`Occupied country: ${occupiedCountry.country.name}`);
console.log(`Occupation day: ${occupationDay}`);
console.log(`Cities: ${selectedCityIds.join(", ")}`);
for (const result of results) {
  console.log("");
  console.log(`${result.city.name} (${result.city.resource}, occupied from day ${occupationDay})`);
  console.log("Best timed order:");
  for (const line of result.top[0]?.ranked.timedOrderLines ?? ["(none)"]) {
    console.log(line);
  }
}
console.error(`[occupied-city-target-beam] html written to ${outputFilePath}`);
