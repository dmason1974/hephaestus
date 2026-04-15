import fs from "node:fs";
import path from "node:path";

import type { CityStatus, Resource, StartingPopulation } from "../../core/constants.js";
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
  air_base: "air_base",
  arms_industry: "arms_industry",
  naval_base: "naval_base",
  relocate_headquarters: "relocate_headquarters",
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
  sequenceLines: string[];
  timedOrderLines: string[];
  endResource: number;
  endCash: number;
  endManpower: number;
  deltaResource: number;
  deltaCash: number;
  deltaManpower: number;
};
type CandidatePlan = {
  tokens: TokenAction[];
  evaluation: Evaluation;
  ranked: RankedSequence;
};

const scenarioId = process.env.BBP_SCENARIO ?? "elite_ww3_2026";
const countryId = process.env.BBP_COUNTRY ?? "indonesia";
const beamWidth = parsePositiveInt(process.env.BBP_WIDTH, 50);
const daysToSimulate = parsePositiveInt(process.env.BBP_DAYS, 28);
const includeRelocateHeadquarters =
  process.env.BBP_INCLUDE_HQ === "1" || process.env.BBP_INCLUDE_HQ === "true";
const hqCityId = process.env.BBP_HQ_CITY ?? "medan";
const cityStatus = parseCityStatus(process.env.BBP_CITY_STATUS);
const outputFilePath = path.resolve(process.env.BBP_OUTPUT_FILE?.trim() || "tmp/beam-city-portfolio-balance.html");
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

function parseCityStatus(value: string | undefined): CityStatus {
  return value === "occupied" || value === "annexed" ? value : "homeland";
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

function htmlTable(rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return "<p><em>None</em></p>";
  const headers = Array.from(
    rows.reduce((set, row) => {
      for (const key of Object.keys(row)) set.add(key);
      return set;
    }, new Set<string>())
  );
  const head = `<tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join("")}</tr>`;
  const body = rows.map(row =>
    `<tr>${headers.map(header => `<td>${escapeHtml(row[header]).replaceAll("\n", "<br>")}</td>`).join("")}</tr>`
  ).join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function hourlyDeltasFromCountryTable(table: ReturnType<typeof buildCountryHourlyResourceBalanceTable>) {
  return table.rows.map((row, index) => {
    const previous = index === 0 ? undefined : table.rows[index - 1]?.balances;
    const delta = zeroResources();
    for (const resource of RESOURCE_KEYS) {
      const currentValue = row.balances[resource] ?? 0;
      const previousValue = previous?.[resource] ?? 0;
      delta[resource] = currentValue - previousValue;
    }
    return delta;
  });
}

function levelData(buildingId: CandidateBuildingId, level: number) {
  const data = buildings.buildings[buildingId]?.levels[String(level) as "1" | "2" | "3" | "4" | "5"];
  if (!data) {
    throw new Error(`Missing ${buildingId} level ${level}`);
  }
  return data;
}

function maxDefinedLevel(buildingId: CandidateBuildingId) {
  const levels = Object.entries(buildings.buildings[buildingId]?.levels ?? {})
    .filter(([, value]) => value)
    .map(([level]) => Number(level));
  return levels.length > 0 ? Math.max(...levels) : 0;
}

function buildCityState(city: typeof country.cities[number]): CityState {
  return {
    cityId: `${country.country.id}:${city.id}`,
    countryId: country.country.id,
    capital: city.capital,
    resource: city.resource,
    startPop: city.population as StartingPopulation,
    cityStatus,
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
  if (includeRelocateHeadquarters && city.id === hqCityId) {
    pool.push("relocate_headquarters");
  }
  return pool;
}

const baselineCountryTable = buildCountryHourlyResourceBalanceTable(
  country,
  daysToSimulate,
  scenario.speed,
  {
    buildingsFile: buildings,
    scenario,
    startingBalances: scenario.starting_balance,
    startAbsoluteHour: scenarioAbsHour,
    cityDefaults: { cityStatus },
    provinceDefaults: { cityStatus },
  }
);
const baselineCountryHourly = hourlyDeltasFromCountryTable(baselineCountryTable).slice(0, hoursToSimulate);

function tokenSequenceKey(tokens: TokenAction[]) {
  return tokens.map(token => `${token.buildingId}:${token.targetLevel}`).join("|");
}

function formatSequenceLines(tokens: TokenAction[]) {
  if (tokens.length === 0) return ["(no build)"];
  return tokens.map((token, index) => `${index + 1}. ${BUILDING_LABELS[token.buildingId]} level ${token.targetLevel}`);
}

function formatTimedOrderLines(actions: BuildAction[]) {
  if (actions.length === 0) return ["(no build)"];
  return actions.map(
    (action, index) =>
      `${index + 1}. ${BUILDING_LABELS[action.buildingId as CandidateBuildingId]} level ${action.targetLevel} at hour ${action.startHour ?? 0}`
  );
}

function compareRanked(a: RankedSequence, b: RankedSequence) {
  return (
    (b.endResource - a.endResource) ||
    a.sequenceLines.join("|").localeCompare(b.sequenceLines.join("|"))
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

function maxSequenceLength(city: typeof country.cities[number], pool: CandidateBuildingId[]) {
  return pool.reduce(
    (sum, buildingId) => sum + (maxDefinedLevel(buildingId) - cityLevelForTokens(city, [], buildingId)),
    0
  );
}

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
  if (!segments) {
    throw new Error(`Missing build segments for ${cityState.cityId}`);
  }

  for (const [buildingId, buildingSegments] of Object.entries(segments) as Array<[CandidateBuildingId, typeof segments[CandidateBuildingId]]>) {
    for (const segment of buildingSegments) {
      const cost = levelData(buildingId, segment.toLevel).cost;
      const startHourIndex = Math.floor(segment.startMinute / 60) - scenarioAbsHour;
      if (startHourIndex >= 0 && startHourIndex < hoursToSimulate) {
        for (const resource of RESOURCE_KEYS) {
          adjustments[startHourIndex][resource] -= cost[resource];
        }
      }

      const upkeep = levelData(buildingId, segment.toLevel).daily_upkeep;
      if (!upkeep) continue;

      const completionHourIndex = Math.ceil(segment.endMinute / 60) - scenarioAbsHour;
      for (let hourIndex = completionHourIndex; hourIndex < hoursToSimulate; hourIndex++) {
        for (const resource of RESOURCE_KEYS) {
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

    for (const resource of RESOURCE_KEYS) {
      const cityProduction = simulation.perHourAggregate[hourIndex]?.production[resource] ?? 0;
      const otherCountryProduction = otherCountryHourly[hourIndex]?.[resource] ?? 0;
      balances[resource] =
        previous[resource] + cityProduction + otherCountryProduction + adjustments[hourIndex][resource];
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

function bestPlanForCity(city: typeof country.cities[number]) {
  const cityState = buildCityState(city);
  const pool = buildingPoolForCity(city);
  const baselineCitySimulation = simulateBuildOrder({
    cities: [cityState],
    buildOrder: [],
    buildings,
    scenario,
    hoursToSimulate,
  });
  const otherCountryHourly = baselineCountryHourly.map((countryRow, index) => {
    const otherRow = zeroResources();
    for (const resource of RESOURCE_KEYS) {
      otherRow[resource] =
        countryRow[resource] - (baselineCitySimulation.perHourAggregate[index]?.production[resource] ?? 0);
    }
    return otherRow;
  });
  const baseline = evaluateTimedOrder(cityState, otherCountryHourly, []);

  function rank(tokens: TokenAction[], evaluation: Evaluation): RankedSequence {
    return {
      sequenceLines: formatSequenceLines(tokens),
      timedOrderLines: formatTimedOrderLines(evaluation.timedOrder),
      deltaResource: evaluation.endingBalances[city.resource] - baseline.endingBalances[city.resource],
      deltaCash: evaluation.endingBalances.cash - baseline.endingBalances.cash,
      deltaManpower: evaluation.endingBalances.manpower - baseline.endingBalances.manpower,
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

      const minStartHour = Math.ceil(currentEvaluation.nextFreeRelHour);
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

      timedOrder = [
        ...timedOrder,
        {
          cityId: cityState.cityId,
          buildingId: token.buildingId,
          targetLevel: token.targetLevel,
          startHour: scheduledStartHour,
        },
      ];
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

  let frontier: CandidatePlan[] = [{
    tokens: [],
    evaluation: baseline,
    ranked: rank([], baseline),
  }];
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
        const candidate = {
          tokens,
          evaluation,
          ranked: rank(tokens, evaluation),
        };
        candidates.set(key, candidate);
        allRanked.set(key, candidate);
      }
    }
    if (candidates.size === 0) break;
    frontier = Array.from(candidates.values())
      .sort((a, b) => compareRanked(a.ranked, b.ranked))
      .slice(0, beamWidth);
  }

  const best = Array.from(allRanked.values())
    .sort((a, b) => compareRanked(a.ranked, b.ranked))[0] ?? frontier[0];
  return {
    city,
    baseline,
    best,
  };
}

const bestPlans = country.cities.map(city => bestPlanForCity(city));
const combinedBuildOrder = bestPlans.flatMap(entry => entry.best?.evaluation.timedOrder ?? []);

const allCityStates = country.cities.map(city => buildCityState(city));
const combinedSimulation = simulateBuildOrder({
  cities: allCityStates,
  buildOrder: combinedBuildOrder,
  buildings,
  scenario,
  hoursToSimulate,
});
const baselineAllCitySimulation = simulateBuildOrder({
  cities: allCityStates,
  buildOrder: [],
  buildings,
  scenario,
  hoursToSimulate,
});
const provinceHourly = baselineCountryHourly.map((countryRow, index) => {
  const row = zeroResources();
  for (const resource of RESOURCE_KEYS) {
    row[resource] =
      countryRow[resource] - (baselineAllCitySimulation.perHourAggregate[index]?.production[resource] ?? 0);
  }
  return row;
});

const combinedSegments = scheduleBuildSegments({
  cities: allCityStates.map(city => ({
    cityId: city.cityId,
    countryId: city.countryId,
    capital: city.capital,
    cityStatus: city.cityStatus,
    moraleParams: city.moraleParams,
    buildings: city.buildings,
  })),
  buildOrder: combinedBuildOrder,
  buildings,
  scenario,
});

const adjustments = Array.from({ length: hoursToSimulate }, () => zeroResources());
for (const buildingSegments of combinedSegments.values()) {
  for (const [buildingId, segments] of Object.entries(buildingSegments) as Array<[CandidateBuildingId, typeof buildingSegments[CandidateBuildingId]]>) {
    for (const segment of segments) {
      const cost = levelData(buildingId, segment.toLevel).cost;
      const startHourIndex = Math.floor(segment.startMinute / 60) - scenarioAbsHour;
      if (startHourIndex >= 0 && startHourIndex < hoursToSimulate) {
        for (const resource of RESOURCE_KEYS) {
          adjustments[startHourIndex][resource] -= cost[resource];
        }
      }
      const upkeep = levelData(buildingId, segment.toLevel).daily_upkeep;
      if (!upkeep) continue;
      const completionHourIndex = Math.ceil(segment.endMinute / 60) - scenarioAbsHour;
      for (let hourIndex = completionHourIndex; hourIndex < hoursToSimulate; hourIndex++) {
        for (const resource of RESOURCE_KEYS) {
          const amount = upkeep[resource];
          if (!Number.isFinite(amount ?? NaN)) continue;
          adjustments[hourIndex][resource] -= Math.floor((amount ?? 0) / 24);
        }
      }
    }
  }
}

const balancesByHour: Array<Record<Resource, number>> = [];
let current = { ...scenario.starting_balance };
for (let hourIndex = 0; hourIndex < hoursToSimulate; hourIndex++) {
  const next = zeroResources();
  for (const resource of RESOURCE_KEYS) {
    const production =
      (combinedSimulation.perHourAggregate[hourIndex]?.production[resource] ?? 0) +
      (provinceHourly[hourIndex]?.[resource] ?? 0);
    next[resource] = (balancesByHour[hourIndex - 1]?.[resource] ?? current[resource]) + production + adjustments[hourIndex][resource];
  }
  balancesByHour.push(next);
}

const dailyRows = Array.from({ length: daysToSimulate }, (_, index) => {
  const endHourIndex = Math.min(hoursToSimulate - 1, ((index + 1) * 24) - 1);
  const endBalances = balancesByHour[endHourIndex] ?? zeroResources();
  const dayHours = balancesByHour.slice(index * 24, Math.min(hoursToSimulate, (index + 1) * 24));
  const minimums = zeroResources();
  for (const resource of RESOURCE_KEYS) {
    minimums[resource] = dayHours.reduce(
      (min, row) => Math.min(min, row[resource]),
      Number.POSITIVE_INFINITY
    );
  }
  return {
    day: index + 1,
    end_supplies: Number(endBalances.supplies.toFixed(2)),
    end_components: Number(endBalances.components.toFixed(2)),
    end_fuel: Number(endBalances.fuel.toFixed(2)),
    end_rares: Number(endBalances.rares.toFixed(2)),
    end_electronics: Number(endBalances.electronics.toFixed(2)),
    end_cash: Number(endBalances.cash.toFixed(2)),
    end_manpower: Number(endBalances.manpower.toFixed(2)),
    min_supplies: Number(minimums.supplies.toFixed(2)),
    min_components: Number(minimums.components.toFixed(2)),
    min_fuel: Number(minimums.fuel.toFixed(2)),
    min_rares: Number(minimums.rares.toFixed(2)),
    min_electronics: Number(minimums.electronics.toFixed(2)),
    min_cash: Number(minimums.cash.toFixed(2)),
    min_manpower: Number(minimums.manpower.toFixed(2)),
  };
});

const recommendationRows = bestPlans.map(entry => ({
  city: entry.city.name,
  resource: entry.city.resource,
  delta_resource: entry.best?.ranked.deltaResource ?? 0,
  end_resource: entry.best?.ranked.endResource ?? entry.baseline.endingBalances[entry.city.resource],
  delta_cash: entry.best?.ranked.deltaCash ?? 0,
  delta_manpower: entry.best?.ranked.deltaManpower ?? 0,
  sequence: entry.best?.ranked.sequenceLines.join("\n") ?? "(no build)",
  timedOrder: entry.best?.ranked.timedOrderLines.join("\n") ?? "(no build)",
}));

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Beam City Portfolio Balance</title><style>
body{font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.4;padding:24px;max-width:1600px;margin:0 auto}
table{border-collapse:collapse;width:100%;margin:12px 0 24px}
th,td{border:1px solid #d0d7de;padding:8px 10px;vertical-align:top;text-align:left}
th{background:#f6f8fa}
h1,h2{margin:20px 0 8px}
</style></head><body>
<h1>Beam City Portfolio Balance</h1>
${htmlTable([{
  scenario: `${scenario.id} (${scenario.speed})`,
  country: country.country.name,
  cityStatus,
  beamWidth,
  windowDays: daysToSimulate,
  includeRelocateHeadquarters,
  hqCityId: includeRelocateHeadquarters ? hqCityId : "",
}])}
<h2>Per-City Recommended Plans</h2>
${htmlTable(recommendationRows)}
<h2>Daily Country Balances</h2>
${htmlTable(dailyRows)}
</body></html>`;

fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
fs.writeFileSync(outputFilePath, html, "utf8");

console.log("Beam city portfolio balance");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(`Country: ${country.country.name}`);
console.log(`City status: ${cityStatus}`);
console.log(`Window: ${daysToSimulate} days`);
console.log(`Beam width: ${beamWidth}`);
console.log("Per-city recommended plans:");
console.table(recommendationRows.map(row => ({
  city: row.city,
  resource: row.resource,
  delta_resource: row.delta_resource,
  end_resource: row.end_resource,
  delta_cash: row.delta_cash,
  delta_manpower: row.delta_manpower,
})));
console.log("Daily country balances:");
console.table(dailyRows);
console.error(`[beam-portfolio] html written to ${outputFilePath}`);
