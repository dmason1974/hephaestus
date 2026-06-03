import path from "node:path";

import type { Resource, StartingPopulation } from "../../core/constants.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import {
  scheduleBuildSegments,
  type BuildAction,
} from "../../engine/orchestration/build-order-timeline.js";
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
  air_base: "air_base",
  arms_industry: "arms_industry",
  naval_base: "naval_base",
  underground_bunkers: "underground_bunkers",
} as const;

type CandidateBuildingId = keyof typeof BUILDING_LABELS;
type TokenAction = {
  buildingId: CandidateBuildingId;
  targetLevel: number;
};
type Evaluation = {
  feasible: boolean;
  timedOrder: BuildAction[];
  balancesByHour: Array<Record<Resource, number>>;
  endingBalances: Record<Resource, number>;
  nextFreeRelHour: number;
};
type RankedSequence = {
  sequenceKey: string;
  sequence: string;
  timedOrder: string;
  deltaResource: number;
  deltaCash: number;
  deltaManpower: number;
  endResource: number;
  endCash: number;
  endManpower: number;
};

const scenarioId = process.env.MC_SCENARIO ?? "elite/ww3";
const countryId = process.env.MC_COUNTRY ?? "indonesia";
const cityFilter = process.env.MC_CITY ?? "all";
const iterations = parsePositiveInt(process.env.MC_ITERATIONS, 10000);
const topN = parsePositiveInt(process.env.MC_TOP, 5);
const progressEvery = parsePositiveInt(process.env.MC_PROGRESS_EVERY, 1000);
const baseSeed = parsePositiveInt(process.env.MC_SEED, 20260324);
const daysToSimulate = parsePositiveInt(process.env.MC_DAYS, 28);
const hoursToSimulate = daysToSimulate * 24;
const maxCachedPrefixLength = parsePositiveInt(process.env.MC_CACHE_PREFIXES, 6);

const scenario = loadScenarioFile(scenarioId);
const country = loadScenarioCountry(scenarioId, countryId);
const buildings = loadBuildingsFile(path.resolve("data/buildings.yml"));
const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);

function parsePositiveInt(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
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

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function levelData(buildingId: CandidateBuildingId, level: number) {
  const data = buildings.buildings[buildingId]?.levels[String(level) as "1" | "2" | "3" | "4" | "5"];
  if (!data) {
    throw new Error(`Missing ${buildingId} level ${level}`);
  }
  return data;
}

function buildCityState(city: typeof country.cities[number]): CityState {
  return {
    cityId: `${country.country.id}:${city.id}`,
    countryId: country.country.id,
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
  };
}

function buildingPoolForCity(city: typeof country.cities[number]): CandidateBuildingId[] {
  const pool: CandidateBuildingId[] = ["arms_industry", "air_base", "underground_bunkers"];
  if (city.starting.naval_base >= 1) {
    pool.push("naval_base");
  }
  return pool;
}

function trackedResourcesForCity(cityState: CityState): Resource[] {
  return Array.from(new Set<Resource>([cityState.resource, "cash", "manpower"]));
}

function tokenSequenceKey(tokens: TokenAction[]) {
  return tokens.map(token => `${token.buildingId}:${token.targetLevel}`).join("|");
}

function formatSequence(tokens: TokenAction[]) {
  if (tokens.length === 0) return "(no build)";
  return tokens
    .map(token => `${BUILDING_LABELS[token.buildingId]} level ${token.targetLevel}`)
    .join(" -> ");
}

function formatTimedOrder(actions: BuildAction[]) {
  if (actions.length === 0) return "(no build)";
  return actions
    .map(
      action =>
        `${BUILDING_LABELS[action.buildingId as CandidateBuildingId]} level ${action.targetLevel} at hour ${action.startHour ?? 0}`
    )
    .join(" -> ");
}

function compareRanked(a: RankedSequence, b: RankedSequence) {
  return (
    (b.deltaResource - a.deltaResource) ||
    (b.deltaCash - a.deltaCash) ||
    (b.deltaManpower - a.deltaManpower) ||
    a.sequence.localeCompare(b.sequence)
  );
}

function cityLevelForTokens(
  city: typeof country.cities[number],
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
  const upgradesTaken = tokens.filter(token => token.buildingId === buildingId).length;
  return startingLevel + upgradesTaken;
}

function evaluateTimedOrder(cityState: CityState, tracked: Resource[], timedOrder: BuildAction[]): Evaluation {
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
  if (!segments) {
    throw new Error(`Missing build segments for ${cityState.cityId}`);
  }

  for (const [buildingId, buildingSegments] of Object.entries(segments) as Array<[CandidateBuildingId, typeof segments[CandidateBuildingId]]>) {
    for (const segment of buildingSegments) {
      const cost = levelData(buildingId, segment.toLevel).cost;
      const startHourIndex = Math.floor(segment.startMinute / 60) - scenarioAbsHour;
      if (startHourIndex >= 0 && startHourIndex < hoursToSimulate) {
        for (const resource of tracked) {
          adjustments[startHourIndex][resource] -= cost[resource];
        }
      }

      const upkeep = levelData(buildingId, segment.toLevel).daily_upkeep;
      if (!upkeep) continue;

      const completionHourIndex = Math.ceil(segment.endMinute / 60) - scenarioAbsHour;
      for (let hourIndex = completionHourIndex; hourIndex < hoursToSimulate; hourIndex++) {
        for (const resource of tracked) {
          const amount = upkeep[resource];
          if (!Number.isFinite(amount ?? NaN)) continue;
          adjustments[hourIndex][resource] -= Math.floor((amount ?? 0) / 24);
        }
      }
    }
  }

  const balancesByHour: Array<Record<Resource, number>> = [];
  const endingBalances = zeroResources();

  for (let hourIndex = 0; hourIndex < hoursToSimulate; hourIndex++) {
    const previous = balancesByHour[hourIndex - 1] ?? zeroResources();
    const balances = zeroResources();

    for (const resource of tracked) {
      const production = simulation.perHourAggregate[hourIndex]?.production[resource] ?? 0;
      balances[resource] = previous[resource] + production + adjustments[hourIndex][resource];
      endingBalances[resource] = balances[resource];
    }

    balancesByHour.push(balances);
  }

  const lastCompletionAbsHour = Object.values(segments)
    .flatMap(buildingSegments => buildingSegments)
    .reduce((latest, segment) => Math.max(latest, segment.endMinute / 60), scenarioAbsHour);

  return {
    feasible: balancesByHour.every(balance => tracked.every(resource => balance[resource] >= 0)),
    timedOrder,
    balancesByHour,
    endingBalances,
    nextFreeRelHour: lastCompletionAbsHour - scenarioAbsHour,
  };
}

function monteCarloCity(city: typeof country.cities[number]) {
  const cityState = buildCityState(city);
  const tracked = trackedResourcesForCity(cityState);
  const pool = buildingPoolForCity(city);
  const baseline = evaluateTimedOrder(cityState, tracked, []);
  const tokenCache = new Map<string, Evaluation>();
  tokenCache.set("", baseline);

  function evaluateTokens(tokens: TokenAction[]) {
    const key = tokenSequenceKey(tokens);
    const cached = tokenCache.get(key);
    if (cached) {
      return cached;
    }

    let timedOrder: BuildAction[] = [];
    let currentEvaluation = baseline;
    const currentTokens: TokenAction[] = [];

    for (const token of tokens) {
      currentTokens.push(token);
      const prefixKey = tokenSequenceKey(currentTokens);
      const prefixCached = tokenCache.get(prefixKey);
      if (prefixCached) {
        timedOrder = prefixCached.timedOrder;
        currentEvaluation = prefixCached;
        continue;
      }

      const minStartHour = Math.ceil(currentEvaluation.nextFreeRelHour);
      const cost = levelData(token.buildingId, token.targetLevel).cost;
      let scheduledStartHour: number | undefined;

      for (let hour = minStartHour; hour < hoursToSimulate; hour++) {
        const available = currentEvaluation.balancesByHour[hour] ?? zeroResources();
        if (tracked.every(resource => available[resource] >= cost[resource])) {
          scheduledStartHour = hour;
          break;
        }
      }

      if (scheduledStartHour === undefined) {
        const failedEvaluation: Evaluation = {
          feasible: false,
          timedOrder,
          balancesByHour: currentEvaluation.balancesByHour,
          endingBalances: currentEvaluation.endingBalances,
          nextFreeRelHour: currentEvaluation.nextFreeRelHour,
        };
        if (currentTokens.length <= maxCachedPrefixLength) {
          tokenCache.set(prefixKey, failedEvaluation);
        }
        return failedEvaluation;
      }

      timedOrder = [
        ...timedOrder,
        {
          cityId: cityState.cityId,
          buildingId: token.buildingId,
          targetLevel: token.targetLevel,
          startHour: scheduledStartHour,
        },
      ];
      currentEvaluation = evaluateTimedOrder(cityState, tracked, timedOrder);
      if (currentTokens.length <= maxCachedPrefixLength) {
        tokenCache.set(prefixKey, currentEvaluation);
      }
    }

    return currentEvaluation;
  }

  function nextFeasibleActions(tokens: TokenAction[]) {
    return pool.flatMap(buildingId => {
      const currentLevel = cityLevelForTokens(city, tokens, buildingId);
      if (currentLevel >= 5) return [];
      const action: TokenAction = {
        buildingId,
        targetLevel: currentLevel + 1,
      };
      const evaluation = evaluateTokens([...tokens, action]);
      return evaluation.feasible ? [action] : [];
    });
  }

  const rng = mulberry32(baseSeed ^ hashString(`${country.country.id}:${city.id}`));
  const seen = new Set<string>();
  const ranked = new Map<string, RankedSequence>();
  let attempts = 0;
  let duplicateCount = 0;
  let infeasibleCount = 0;
  let bestRanked: RankedSequence | undefined;

  while (seen.size < iterations && attempts < iterations * 20) {
    attempts += 1;
    const tokens: TokenAction[] = [];

    for (;;) {
      const options = nextFeasibleActions(tokens);
      if (options.length === 0) break;
      if (tokens.length > 0 && rng() < 0.2) break;
      const selected = options[Math.floor(rng() * options.length)];
      tokens.push(selected);
    }

    if (tokens.length === 0) continue;

    const key = tokenSequenceKey(tokens);
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);

    const evaluation = evaluateTokens(tokens);
    if (!evaluation.feasible) {
      infeasibleCount += 1;
      continue;
    }

    const deltaResource = evaluation.endingBalances[city.resource] - baseline.endingBalances[city.resource];
    const deltaCash = evaluation.endingBalances.cash - baseline.endingBalances.cash;
    const deltaManpower = evaluation.endingBalances.manpower - baseline.endingBalances.manpower;

    const rankedEntry = {
      sequenceKey: key,
      sequence: formatSequence(tokens),
      timedOrder: formatTimedOrder(evaluation.timedOrder),
      deltaResource,
      deltaCash,
      deltaManpower,
      endResource: evaluation.endingBalances[city.resource],
      endCash: evaluation.endingBalances.cash,
      endManpower: evaluation.endingBalances.manpower,
    };
    ranked.set(key, rankedEntry);
    if (!bestRanked || compareRanked(rankedEntry, bestRanked) < 0) {
      bestRanked = rankedEntry;
    }

    if (progressEvery > 0 && seen.size % progressEvery === 0) {
      console.log(
        `[mc] ${city.name}: accepted ${seen.size}/${iterations} unique feasible sequences after ${attempts} attempts, duplicates ${duplicateCount}, infeasible ${infeasibleCount}`
      );
      if (bestRanked) {
        console.log(`[mc] ${city.name}: current best sequence: ${bestRanked.sequence}`);
        console.log(`[mc] ${city.name}: current best timed order: ${bestRanked.timedOrder}`);
        console.log(
          `[mc] ${city.name}: current best deltas: ${city.resource} ${bestRanked.deltaResource}, cash ${bestRanked.deltaCash}, manpower ${bestRanked.deltaManpower}`
        );
      }
    }
  }

  const top = Array.from(ranked.values()).sort(compareRanked).slice(0, topN);

  return {
    city,
    tracked,
    baseline,
    top,
    uniqueSequences: seen.size,
    attempts,
    duplicateCount,
    infeasibleCount,
    pool,
  };
}

const selectedCities = cityFilter === "all"
  ? country.cities
  : country.cities.filter(city => city.id === cityFilter);

if (selectedCities.length === 0) {
  throw new Error(`No cities matched MC_CITY=${cityFilter}`);
}

console.log("Elite WW3 city Monte Carlo");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(`Country: ${country.country.name}`);
console.log(`Window: ${daysToSimulate} days (${hoursToSimulate} hours)`);
console.log(`Iterations per city: ${iterations}`);
console.log("Assumptions:");
console.log("- city characteristics come directly from the country YAML");
console.log("- no capital move; relocate_headquarters is excluded");
console.log("- city-level affordability only uses the city's produced resource, cash, and manpower");
console.log("- other resource costs are ignored for affordability and net balance checks");
console.log("- build starts are delayed until the city can afford them without tracked balances going negative");
console.log("- ranking is by net city-resource gain, then net cash, then net manpower versus no build");

for (const city of selectedCities) {
  const result = monteCarloCity(city);
  console.log("");
  console.log(`${city.name} (${city.resource}${city.capital ? ", capital" : ""})`);
  console.log(
    `Starting: AB${city.starting.air_base}, NB${city.starting.naval_base}, B${city.starting.underground_bunkers}`
  );
  console.log(`Tracked resources: ${result.tracked.join(", ")}`);
  console.log(
    `Evaluated ${result.uniqueSequences} unique feasible sequences after ${result.attempts} attempts (${result.duplicateCount} duplicates, ${result.infeasibleCount} infeasible)`
  );
  console.log("Top sequences:");
  console.table(
    result.top.map((entry, index) => ({
      rank: index + 1,
      sequence: entry.sequence,
      deltaResource: entry.deltaResource,
      deltaCash: entry.deltaCash,
      deltaManpower: entry.deltaManpower,
      endResource: entry.endResource,
      endCash: entry.endCash,
      endManpower: entry.endManpower,
    }))
  );
  console.log("Best timed order:");
  console.log(result.top[0]?.timedOrder ?? "(none)");
}
