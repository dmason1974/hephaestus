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
  air_base: "air_base",
  arms_industry: "arms_industry",
  military_hospital: "military_hospital",
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
  sequenceKey: string;
  sequence: string;
  timedOrder: string;
  sequenceLines: string[];
  timedOrderLines: string[];
  deltaResource: number;
  deltaCash: number;
  deltaManpower: number;
  endResource: number;
  endCash: number;
  endManpower: number;
};
type CandidatePlan = {
  tokens: TokenAction[];
  evaluation: Evaluation;
  ranked: RankedSequence;
};

const scenarioId = process.env.BS_SCENARIO ?? "elite_ww3_2026";
const countryId = process.env.BS_COUNTRY ?? process.env.MC_COUNTRY ?? "indonesia";
const cityFilter = process.env.BS_CITY ?? "all";
const beamWidth = parsePositiveInt(process.env.BS_WIDTH, 50);
const topN = parsePositiveInt(process.env.BS_TOP, 5);
const daysToSimulate = parsePositiveInt(process.env.BS_DAYS, 28);
const progressEveryDepth = parsePositiveInt(process.env.BS_PROGRESS_EVERY_DEPTH, 1);
const includeRelocateHeadquarters =
  process.env.BS_INCLUDE_HQ === "1" || process.env.BS_INCLUDE_HQ === "true";
const hqCityId = process.env.BS_HQ_CITY ?? "medan";
const outputMode = (process.env.BS_OUTPUT ?? "terminal").trim().toLowerCase();
const isMarkdownOutput = outputMode === "markdown" || outputMode === "md" || outputMode === "notion";
const terminalView = (process.env.BS_TERMINAL_VIEW ?? "timed-order").trim().toLowerCase();
const outputFilePath = path.resolve(process.env.BS_OUTPUT_FILE?.trim() || "tmp/beam-city-output.html");
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
    cityStatus: "homeland",
    buildings: {
      army_base: 0,
      air_base: city.starting.air_base,
      annex_city: 0,
      arms_industry: 0,
      combat_outpost: 0,
      local_industry: 0,
      military_hospital: 0,
      naval_base: city.starting.naval_base,
      recruiting_office: 0,
      relocate_headquarters: 0,
      underground_bunkers: city.starting.underground_bunkers,
    },
  };
}

function buildingPoolForCity(city: typeof country.cities[number]): CandidateBuildingId[] {
  const pool: CandidateBuildingId[] = ["arms_industry", "air_base", "military_hospital", "underground_bunkers"];
  if (city.starting.naval_base >= 1) {
    pool.push("naval_base");
  }
  if (includeRelocateHeadquarters && city.id === hqCityId) {
    pool.push("relocate_headquarters");
  }
  return pool;
}

function trackedResourcesForCity(cityState: CityState): Resource[] {
  return Array.from(new Set<Resource>([cityState.resource, "cash", "manpower"]));
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
  }
);
const baselineCountryHourly = hourlyDeltasFromCountryTable(baselineCountryTable).slice(0, hoursToSimulate);

function tokenSequenceKey(tokens: TokenAction[]) {
  return tokens.map(token => `${token.buildingId}:${token.targetLevel}`).join("|");
}

function formatSequence(tokens: TokenAction[]) {
  if (tokens.length === 0) return "(no build)";
  return tokens
    .map(token => `${BUILDING_LABELS[token.buildingId]} level ${token.targetLevel}`)
    .join(" -> ");
}

function formatSequenceLines(tokens: TokenAction[]) {
  if (tokens.length === 0) return ["(no build)"];
  return tokens.map((token, index) => `${index + 1}. ${BUILDING_LABELS[token.buildingId]} level ${token.targetLevel}`);
}

function formatTimedOrder(actions: BuildAction[]) {
  if (actions.length === 0) return "(no build)";
  return actions
    .map(action => `${BUILDING_LABELS[action.buildingId as CandidateBuildingId]} level ${action.targetLevel} at hour ${action.startHour ?? 0}`)
    .join(" -> ");
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
    a.sequence.localeCompare(b.sequence)
  );
}

function markdownValue(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function printMarkdownTable(rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) {
    console.log("_None_");
    return;
  }

  const headers = Array.from(
    rows.reduce((set, row) => {
      for (const key of Object.keys(row)) set.add(key);
      return set;
    }, new Set<string>())
  );

  console.log(`| ${headers.join(" | ")} |`);
  console.log(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows) {
    console.log(`| ${headers.map(header => markdownValue(row[header])).join(" | ")} |`);
  }
}

function printMarkdownList(lines: string[]) {
  if (lines.length === 0) {
    console.log("_None_");
    return;
  }
  for (const line of lines) {
    console.log(`- ${line}`);
  }
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

function htmlList(lines: string[]) {
  if (lines.length === 0) return "<p><em>None</em></p>";
  return `<ul>${lines.map(line => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`;
}

function renderHtmlOutput() {
  const sections: string[] = [];
  sections.push(`<h1>City Beam Search</h1>`);
  sections.push(`<h2>Summary</h2>`);
  sections.push(htmlTable([{
    scenario: `${scenario.id} (${scenario.speed})`,
    country: country.country.name,
    cityFilter,
    windowDays: daysToSimulate,
    beamWidth,
    includeRelocateHeadquarters,
    hqCityId: includeRelocateHeadquarters ? hqCityId : "",
    ranking: "gross ending city resource",
  }]));
  sections.push(`<h2>Assumptions</h2>`);
  sections.push(htmlList([
    "City characteristics come directly from the country YAML.",
    includeRelocateHeadquarters
      ? `relocate_headquarters is allowed only for ${hqCityId}.`
      : "No capital move; relocate_headquarters is excluded.",
    "Affordability uses the full country resource pool with scenario starting_balance and baseline no-build income.",
    "Only the selected city's build queue changes; other cities remain on baseline no-build output.",
    "Ranking is by gross ending city resource.",
  ]));

  for (const { city, result } of cityResults) {
    sections.push(`<h2>${escapeHtml(city.name)}</h2>`);
    sections.push(`<h3>Best Timed Order</h3>`);
    sections.push(htmlList(result.top[0]?.timedOrderLines ?? ["(none)"]));
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>City Beam Search</title><style>
body{font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.4;padding:24px;max-width:1400px;margin:0 auto}
table{border-collapse:collapse;width:100%;margin:12px 0 24px}
th,td{border:1px solid #d0d7de;padding:8px 10px;vertical-align:top;text-align:left}
th{background:#f6f8fa}
h1,h2,h3{margin:20px 0 8px}
ul{margin:8px 0 20px}
</style></head><body>${sections.join("")}</body></html>`;
}

function writeHtmlArtifact() {
  const rendered = renderHtmlOutput();
  fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
  fs.writeFileSync(outputFilePath, rendered, "utf8");
  return outputFilePath;
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
          : buildingId === "relocate_headquarters"
            ? 0
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

function beamSearchCity(city: typeof country.cities[number]) {
  const cityState = buildCityState(city);
  const tracked = trackedResourcesForCity(cityState);
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
  const baselineRanked: RankedSequence = {
    sequenceKey: "",
    sequence: "(no build)",
    timedOrder: "(no build)",
    sequenceLines: ["(no build)"],
    timedOrderLines: ["(no build)"],
    deltaResource: 0,
    deltaCash: 0,
    deltaManpower: 0,
    endResource: baseline.endingBalances[city.resource],
    endCash: baseline.endingBalances.cash,
    endManpower: baseline.endingBalances.manpower,
  };

  function rank(tokens: TokenAction[], evaluation: Evaluation): RankedSequence {
    return {
      sequenceKey: tokenSequenceKey(tokens),
      sequence: formatSequence(tokens),
      timedOrder: formatTimedOrder(evaluation.timedOrder),
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
    if (cached) {
      return cached;
    }

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
      return [{
        buildingId,
        targetLevel: currentLevel + 1,
      } satisfies TokenAction];
    });
  }

  const seen = new Set<string>([""]);
  let frontier: CandidatePlan[] = [{
    tokens: [],
    evaluation: baseline,
    ranked: baselineRanked,
  }];
  const allRanked = new Map<string, RankedSequence>();
  const firstStepOptions = nextActions([])
    .map(action => {
      const tokens = [action];
      const evaluation = evaluateTokens(tokens);
      if (!evaluation.feasible) return null;
      return rank(tokens, evaluation);
    })
    .filter((entry): entry is RankedSequence => entry !== null)
    .sort(compareRanked);

  const totalDepth = maxSequenceLength(city, pool);

  for (let depth = 1; depth <= totalDepth; depth++) {
    const candidates = new Map<string, CandidatePlan>();

    for (const plan of frontier) {
      for (const action of nextActions(plan.tokens)) {
        const tokens = [...plan.tokens, action];
        const key = tokenSequenceKey(tokens);
        if (seen.has(key)) continue;
        seen.add(key);

        const evaluation = evaluateTokens(tokens);
        if (!evaluation.feasible) continue;

        const ranked = rank(tokens, evaluation);
        allRanked.set(key, ranked);
        candidates.set(key, {
          tokens,
          evaluation,
          ranked,
        });
      }
    }

    if (candidates.size === 0) {
      break;
    }

    frontier = Array.from(candidates.values())
      .sort((a, b) => compareRanked(a.ranked, b.ranked))
      .slice(0, beamWidth);

    if (!isMarkdownOutput && progressEveryDepth > 0 && depth % progressEveryDepth === 0) {
      const bestAtDepth = frontier[0]?.ranked;
      console.log(
        `[beam] ${city.name}: depth ${depth}/${totalDepth}, frontier ${frontier.length}, best ${bestAtDepth?.sequence ?? "(none)"}`
      );
    }
  }

  const top = Array.from(allRanked.values()).sort(compareRanked).slice(0, topN);

  return {
    city,
    tracked,
    baseline,
    firstStepOptions,
    top,
    beamWidth,
    explored: seen.size - 1,
  };
}

const selectedCities = cityFilter === "all"
  ? country.cities
  : country.cities.filter(city => city.id === cityFilter);

if (selectedCities.length === 0) {
  throw new Error(`No cities matched BS_CITY=${cityFilter}`);
}

const cityResults = selectedCities.map(city => ({
  city,
  result: beamSearchCity(city),
}));

function printMarkdownOutput() {
  console.log("# City Beam Search");
  console.log("");
  console.log("## Summary");
  console.log("");
  printMarkdownTable([{
    scenario: `${scenario.id} (${scenario.speed})`,
    country: country.country.name,
    cityFilter,
    windowDays: daysToSimulate,
    beamWidth,
    includeRelocateHeadquarters,
    hqCityId: includeRelocateHeadquarters ? hqCityId : "",
    ranking: "gross ending city resource",
  }]);
  console.log("");
  console.log("## Assumptions");
  console.log("");
  printMarkdownList([
    "City characteristics come directly from the country YAML.",
    includeRelocateHeadquarters
      ? `relocate_headquarters is allowed only for ${hqCityId}.`
      : "No capital move; relocate_headquarters is excluded.",
    "Affordability uses the full country resource pool with scenario starting_balance and baseline no-build income.",
    "Only the selected city's build queue changes; other cities remain on baseline no-build output.",
    "Ranking is by gross ending city resource.",
  ]);

  for (const { city, result } of cityResults) {
    console.log("");
    console.log(`## ${city.name}`);
    console.log("");
    printMarkdownTable([{
      resource: city.resource,
      capital: city.capital,
      startingAirBase: city.starting.air_base,
      startingNavalBase: city.starting.naval_base,
      startingUndergroundBunkers: city.starting.underground_bunkers,
      trackedResources: result.tracked.join(", "),
      exploredFeasibleSequences: result.explored,
    }]);
    console.log("");
    console.log("### First-Step Options");
    printMarkdownTable(
      result.firstStepOptions.map(entry => ({
        firstStep: entry.sequence,
        [`delta_${city.resource}`]: entry.deltaResource,
        delta_cash: entry.deltaCash,
        delta_manpower: entry.deltaManpower,
        [`end_${city.resource}`]: entry.endResource,
        end_cash: entry.endCash,
        end_manpower: entry.endManpower,
      }))
    );
    console.log("");
    console.log("### Top Sequences");
    printMarkdownTable(
      result.top.map((entry, index) => ({
        rank: index + 1,
        [`delta_${city.resource}`]: entry.deltaResource,
        delta_cash: entry.deltaCash,
        delta_manpower: entry.deltaManpower,
        [`end_${city.resource}`]: entry.endResource,
        end_cash: entry.endCash,
        end_manpower: entry.endManpower,
        sequence: entry.sequenceLines.join("<br>"),
      }))
    );
    console.log("");
    console.log("### Best Timed Order");
    printMarkdownList(result.top[0]?.timedOrderLines ?? ["(none)"]);
  }
}

const htmlArtifactPath = writeHtmlArtifact();

if (isMarkdownOutput) {
  printMarkdownOutput();
  console.error(`[beam-city] html written to ${htmlArtifactPath}`);
} else {
  console.log("Elite WW3 city beam search");
  console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
  console.log(`Country: ${country.country.name}`);
  console.log(`Window: ${daysToSimulate} days (${hoursToSimulate} hours)`);
  console.log(`Beam width: ${beamWidth}`);
  console.log("Assumptions:");
  console.log("- city characteristics come directly from the country YAML");
  console.log(
    includeRelocateHeadquarters
      ? `- relocate_headquarters is allowed only for ${hqCityId}`
      : "- no capital move; relocate_headquarters is excluded"
  );
  console.log("- affordability uses the full country resource pool with scenario starting_balance and baseline no-build income");
  console.log("- only the selected city's build queue changes; other cities remain on baseline no-build output");
  console.log("- ranking is by gross ending city resource");

  for (const { city, result } of cityResults) {
    console.log("");
    console.log(`${city.name} (${city.resource}${city.capital ? ", capital" : ""})`);
    console.log("Best timed order:");
    for (const line of result.top[0]?.timedOrderLines ?? ["(none)"]) {
      console.log(line);
    }

    if (terminalView !== "timed-order") {
      console.log("");
      console.log(
        `Starting: air_base level ${city.starting.air_base}, naval_base level ${city.starting.naval_base}, underground_bunkers level ${city.starting.underground_bunkers}`
      );
      console.log(`Tracked resources: ${result.tracked.join(", ")}`);
      console.log(`Explored feasible sequences: ${result.explored}`);
      console.log("First-step options:");
      console.table(
        result.firstStepOptions.map(entry => ({
          firstStep: entry.sequence,
          [`delta_${city.resource}`]: entry.deltaResource,
          delta_cash: entry.deltaCash,
          delta_manpower: entry.deltaManpower,
          [`end_${city.resource}`]: entry.endResource,
          end_cash: entry.endCash,
          end_manpower: entry.endManpower,
        }))
      );
      console.log("Top sequences:");
      result.top.forEach((entry, index) => {
        console.log(`Rank ${index + 1}`);
        console.log(`Delta ${city.resource}: ${entry.deltaResource}`);
        console.log(`Delta cash: ${entry.deltaCash}`);
        console.log(`Delta manpower: ${entry.deltaManpower}`);
        console.log(`End ${city.resource}: ${entry.endResource}`);
        console.log(`End cash: ${entry.endCash}`);
        console.log(`End manpower: ${entry.endManpower}`);
        console.log("Sequence:");
        for (const line of entry.sequenceLines) {
          console.log(line);
        }
        console.log("");
      });
    }
  }
  console.error(`[beam-city] html written to ${htmlArtifactPath}`);
}
