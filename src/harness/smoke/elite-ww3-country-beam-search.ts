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

const SCORE_WEIGHTS: Record<Resource, number> = {
  supplies: 1,
  components: 1,
  fuel: 1,
  rares: 1,
  electronics: 1,
  cash: 0.25,
  manpower: 0.25,
};

const BUILDING_LABELS = {
  air_base: "air_base",
  arms_industry: "arms_industry",
  naval_base: "naval_base",
  relocate_headquarters: "relocate_headquarters",
  underground_bunkers: "underground_bunkers",
} as const;

type CandidateBuildingId = keyof typeof BUILDING_LABELS;
type CountryTokenAction = {
  cityId: string;
  cityName: string;
  buildingId: CandidateBuildingId;
  targetLevel: number;
};
type Evaluation = {
  feasible: boolean;
  timedOrder: BuildAction[];
  balancesByHour: Array<Record<Resource, number>>;
  endingBalances: Record<Resource, number>;
  cityNextFreeRelHour: Record<string, number>;
};
type RankedSequence = {
  sequenceKey: string;
  sequenceLines: string[];
  timedOrderLines: string[];
  timedOrder: BuildAction[];
  deltas: Record<Resource, number>;
  endingBalances: Record<Resource, number>;
  score: number;
};
type CandidatePlan = {
  tokens: CountryTokenAction[];
  evaluation: Evaluation;
  ranked: RankedSequence;
};

const scenarioId = process.env.BSC_SCENARIO ?? "elite/ww3";
const countryId = process.env.BSC_COUNTRY ?? "indonesia";
const beamWidth = parsePositiveInt(process.env.BSC_WIDTH, 50);
const topN = parsePositiveInt(process.env.BSC_TOP, 5);
const daysToSimulate = parsePositiveInt(process.env.BSC_DAYS, 28);
const progressEveryDepth = parsePositiveInt(process.env.BSC_PROGRESS_EVERY_DEPTH, 1);
const includeRelocateHeadquarters =
  process.env.BSC_INCLUDE_HQ === "1" || process.env.BSC_INCLUDE_HQ === "true";
const hqCityIds = new Set(
  (process.env.BSC_HQ_CITY ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
);
const outputMode = (process.env.BSC_OUTPUT ?? "terminal").trim().toLowerCase();
const isMarkdownOutput = outputMode === "markdown" || outputMode === "md" || outputMode === "notion";
const outputFilePath = path.resolve(process.env.BSC_OUTPUT_FILE?.trim() || "tmp/beam-country-output.html");
const buildPlanFilePath = path.resolve(process.env.BSC_PLAN_FILE?.trim() || `tmp/${countryId}-build-plan.html`);
const ecoProjFilePath = path.resolve(process.env.BSC_ECO_FILE?.trim() || `tmp/${countryId}-eco-projection.html`);
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
      naval_base: city.starting.naval_base,
      recruiting_office: 0,
      relocate_headquarters: 0,
      underground_bunkers: city.starting.underground_bunkers,
    },
  };
}

const cities = country.cities.map(buildCityState);
const cityById = new Map(country.cities.map(city => [`${country.country.id}:${city.id}`, city] as const));

function buildingPoolForCity(city: typeof country.cities[number]): CandidateBuildingId[] {
  const pool: CandidateBuildingId[] = ["arms_industry", "air_base", "underground_bunkers"];
  if (city.starting.naval_base >= 1) {
    pool.push("naval_base");
  }
  if (includeRelocateHeadquarters && hqCityIds.has(city.id)) {
    pool.push("relocate_headquarters");
  }
  return pool;
}

const poolByCity = new Map(
  country.cities.map(city => [`${country.country.id}:${city.id}`, buildingPoolForCity(city)] as const)
);

function countryLevelForTokens(
  city: typeof country.cities[number],
  tokens: CountryTokenAction[],
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
  const upgradesTaken = tokens.filter(
    token => token.cityId === `${country.country.id}:${city.id}` && token.buildingId === buildingId
  ).length;
  return startingLevel + upgradesTaken;
}

function formatSequenceLines(tokens: CountryTokenAction[]) {
  if (tokens.length === 0) return ["(no build)"];
  return tokens.map(
    (token, index) =>
      `${index + 1}. ${token.cityName}: ${BUILDING_LABELS[token.buildingId]} level ${token.targetLevel}`
  );
}

function formatTimedOrderLines(actions: BuildAction[]) {
  if (actions.length === 0) return ["(no build)"];
  return actions.map((action, index) => {
    const city = cityById.get(action.cityId);
    const cityName = city?.name ?? action.cityId;
    return `${index + 1}. ${cityName}: ${BUILDING_LABELS[action.buildingId as CandidateBuildingId]} level ${action.targetLevel} at hour ${action.startHour ?? 0}`;
  });
}

function sequenceKey(tokens: CountryTokenAction[]) {
  return tokens.map(token => `${token.cityId}:${token.buildingId}:${token.targetLevel}`).join("|");
}

function compareRanked(a: RankedSequence, b: RankedSequence) {
  const scoreDelta = b.score - a.score;
  if (scoreDelta !== 0) return scoreDelta;
  for (const resource of RESOURCE_KEYS) {
    const delta = b.deltas[resource] - a.deltas[resource];
    if (delta !== 0) return delta;
  }
  return a.sequenceKey.localeCompare(b.sequenceKey);
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
  return `<!doctype html><html><head><meta charset="utf-8"><title>Country Beam Search</title><style>
body{font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.4;padding:24px;max-width:1400px;margin:0 auto}
table{border-collapse:collapse;width:100%;margin:12px 0 24px}
th,td{border:1px solid #d0d7de;padding:8px 10px;vertical-align:top;text-align:left}
th{background:#f6f8fa}
h1,h2{margin:20px 0 8px}
ul{margin:8px 0 20px}
</style></head><body>
<h1>Country Beam Search</h1>
<h2>Summary</h2>
${htmlTable([{
  scenario: `${scenario.id} (${scenario.speed})`,
  country: country.country.name,
  windowDays: daysToSimulate,
  beamWidth,
  exploredFeasibleSequences: result.explored,
  includeRelocateHeadquarters,
  hqCityIds: includeRelocateHeadquarters ? [...hqCityIds].join(", ") : "",
  ranking: "balanced economy proxy",
}])}
<h2>Assumptions</h2>
${htmlList([
  "Pooled country balances are used across all cities.",
  "Each city keeps its own build queue timing.",
  "Provinces contribute baseline income but are not built up.",
  "Ranking uses a balanced economy proxy.",
  "Weights: supplies 1, components 1, fuel 1, rares 1, electronics 1, cash 0.25, manpower 0.25.",
  includeRelocateHeadquarters
    ? `relocate_headquarters is allowed for: ${[...hqCityIds].join(", ")}.`
    : "relocate_headquarters is excluded.",
])}
<h2>Top Sequences</h2>
${htmlTable(result.top.map((entry, index) => ({
  rank: index + 1,
  score: entry.score,
  delta_supplies: entry.deltas.supplies,
  delta_components: entry.deltas.components,
  delta_fuel: entry.deltas.fuel,
  delta_rares: entry.deltas.rares,
  delta_electronics: entry.deltas.electronics,
  delta_cash: entry.deltas.cash,
  delta_manpower: entry.deltas.manpower,
  sequence: entry.sequenceLines.join("\n"),
  timedOrder: entry.timedOrderLines.join("\n"),
})))}
</body></html>`;
}

function writeHtmlArtifact() {
  const rendered = renderHtmlOutput();
  fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
  fs.writeFileSync(outputFilePath, rendered, "utf8");
  return outputFilePath;
}

function formatGameTime(relHour: number): string {
  const absHour = scenario.start.hour + relHour;
  const day = scenario.start.day + Math.floor(absHour / 24);
  const hour = absHour % 24;
  return `Day ${day}, ${String(hour).padStart(2, "0")}:00`;
}

function renderBuildPlanHtml(topPlan: RankedSequence): string {
  const segments = scheduleBuildSegments({
    cities: cities.map(city => ({
      cityId: city.cityId,
      countryId: city.countryId,
      capital: city.capital,
      cityStatus: city.cityStatus,
      moraleParams: city.moraleParams,
      buildings: city.buildings,
    })),
    buildOrder: topPlan.timedOrder,
    buildings,
    scenario,
  });

  const allSegments: Array<{
    city: string;
    building: string;
    level: number;
    startHour: number;
    endHour: number;
  }> = [];
  for (const [cityId, buildingSegments] of segments.entries()) {
    const cityName = cityById.get(cityId)?.name ?? cityId;
    for (const [buildingId, segs] of Object.entries(buildingSegments) as Array<[string, any[]]>) {
      for (const seg of segs) {
        allSegments.push({
          city: cityName,
          building: buildingId,
          level: seg.toLevel,
          startHour: Math.round((seg.startMinute / 60) - scenarioAbsHour),
          endHour: Math.round((seg.endMinute / 60) - scenarioAbsHour),
        });
      }
    }
  }
  allSegments.sort((a, b) => a.startHour - b.startHour || a.city.localeCompare(b.city));

  const byCityRows: Array<Record<string, unknown>> = [];
  for (const city of country.cities) {
    const cityId = `${country.country.id}:${city.id}`;
    const citySegs = allSegments.filter(s => s.city === city.name);
    if (citySegs.length === 0) {
      byCityRows.push({ city: city.name, queue: "(no builds)" });
    } else {
      byCityRows.push({
        city: city.name,
        queue: citySegs.map(s => `L${s.level} ${s.building} — ${formatGameTime(s.startHour)} → ${formatGameTime(s.endHour)}`).join("\n"),
      });
    }
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>Build Plan — ${country.country.name}</title><style>
body{font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.4;padding:24px;max-width:1400px;margin:0 auto}
table{border-collapse:collapse;width:100%;margin:12px 0 24px}
th,td{border:1px solid #d0d7de;padding:8px 10px;vertical-align:top;text-align:left}
th{background:#f6f8fa}
h1,h2{margin:20px 0 8px}
</style></head><body>
<h1>Build Plan — ${escapeHtml(country.country.name)}</h1>
${htmlTable([{
  scenario: `${scenario.id} (${scenario.speed})`,
  country: country.country.name,
  doctrine: country.country.doctrine,
  windowDays: daysToSimulate,
  rank: 1,
  score: topPlan.score,
}])}
<h2>Chronological Build Order</h2>
${htmlTable(allSegments.map((s, i) => ({
  step: i + 1,
  city: s.city,
  building: s.building,
  level: s.level,
  starts: formatGameTime(s.startHour),
  completes: formatGameTime(s.endHour),
  duration_h: s.endHour - s.startHour,
})))}
<h2>Per-City Queues</h2>
${htmlTable(byCityRows)}
</body></html>`;
}

function renderEcoProjectionHtml(topPlan: RankedSequence): string {
  const planEval = evaluateTimedOrder(topPlan.timedOrder);
  const DAY_HOURS = Array.from({ length: daysToSimulate + 1 }, (_, i) => i * 24);

  const rows = DAY_HOURS.map(h => {
    const planBal = planEval.balancesByHour[h] ?? planEval.endingBalances;
    const baseBal = baseline.balancesByHour[h] ?? baseline.endingBalances;
    return {
      day: h === 0 ? "Start" : `Day ${Math.floor(h / 24)}`,
      supplies: Math.round(planBal.supplies),
      components: Math.round(planBal.components),
      fuel: Math.round(planBal.fuel),
      rares: Math.round(planBal.rares),
      electronics: Math.round(planBal.electronics),
      cash: Math.round(planBal.cash),
      manpower: Math.round(planBal.manpower),
      vs_baseline_score: Math.round(
        RESOURCE_KEYS.reduce((sum, r) => sum + ((planBal[r] - baseBal[r]) * SCORE_WEIGHTS[r]), 0)
      ),
    };
  });

  return `<!doctype html><html><head><meta charset="utf-8"><title>Eco Projection — ${country.country.name}</title><style>
body{font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.4;padding:24px;max-width:1400px;margin:0 auto}
table{border-collapse:collapse;width:100%;margin:12px 0 24px}
th,td{border:1px solid #d0d7de;padding:8px 10px;vertical-align:top;text-align:right}
th{background:#f6f8fa;text-align:left}
td:first-child{text-align:left}
h1,h2{margin:20px 0 8px}
</style></head><body>
<h1>Eco Projection — ${escapeHtml(country.country.name)}</h1>
${htmlTable([{
  scenario: `${scenario.id} (${scenario.speed})`,
  country: country.country.name,
  doctrine: country.country.doctrine,
  windowDays: daysToSimulate,
  plan_score: topPlan.score,
  note: "Cumulative balance at end of each day under winning build plan",
}])}
<h2>Daily Resource Balance (Winning Plan)</h2>
${htmlTable(rows)}
<h2>Winning Build Sequence (reference)</h2>
${htmlTable([{ sequence: topPlan.sequenceLines.join("\n") }])}
</body></html>`;
}

function writeBuildPlanArtifact(topPlan: RankedSequence) {
  if (!topPlan) return null;
  const rendered = renderBuildPlanHtml(topPlan);
  fs.mkdirSync(path.dirname(buildPlanFilePath), { recursive: true });
  fs.writeFileSync(buildPlanFilePath, rendered, "utf8");
  return buildPlanFilePath;
}

function writeEcoProjArtifact(topPlan: RankedSequence) {
  if (!topPlan) return null;
  const rendered = renderEcoProjectionHtml(topPlan);
  fs.mkdirSync(path.dirname(ecoProjFilePath), { recursive: true });
  fs.writeFileSync(ecoProjFilePath, rendered, "utf8");
  return ecoProjFilePath;
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

const baselineCountryTable = buildCountryHourlyResourceBalanceTable(
  country,
  daysToSimulate,
  scenario.speed,
  {
    buildingsFile: buildings,
    scenario,
    startAbsoluteHour: scenarioAbsHour,
  }
);
const baselineCountryHourly = hourlyDeltasFromCountryTable(baselineCountryTable).slice(0, hoursToSimulate);
const baselineCitySimulation = simulateBuildOrder({
  cities,
  buildOrder: [],
  buildings,
  scenario,
  hoursToSimulate,
});
const provinceHourly = baselineCountryHourly.map((countryRow, index) => {
  const provinceRow = zeroResources();
  for (const resource of RESOURCE_KEYS) {
    provinceRow[resource] =
      countryRow[resource] - (baselineCitySimulation.perHourAggregate[index]?.production[resource] ?? 0);
  }
  return provinceRow;
});

function evaluateTimedOrder(timedOrder: BuildAction[]): Evaluation {
  const simulation = simulateBuildOrder({
    cities,
    buildOrder: timedOrder,
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
    buildOrder: timedOrder,
    buildings,
    scenario,
  });

  const adjustments = Array.from({ length: hoursToSimulate }, () => zeroResources());
  for (const buildingSegments of segmentsByCity.values()) {
    for (const [buildingId, segments] of Object.entries(buildingSegments) as Array<[CandidateBuildingId, typeof buildingSegments[CandidateBuildingId]]>) {
      for (const segment of segments) {
        const cost = levelData(buildingId, segment.toLevel).cost;
        const startHourIndex = Math.floor(segment.startMinute / 60) - scenarioAbsHour;
        if (startHourIndex >= 0 && startHourIndex < hoursToSimulate) {
          for (const resource of RESOURCE_KEYS) {
            adjustments[startHourIndex][resource] -= cost[resource] ?? 0;
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
  const endingBalances = zeroResources();
  for (let hourIndex = 0; hourIndex < hoursToSimulate; hourIndex++) {
    const previous = balancesByHour[hourIndex - 1] ?? zeroResources();
    const balances = zeroResources();
    for (const resource of RESOURCE_KEYS) {
      const cityProduction = simulation.perHourAggregate[hourIndex]?.production[resource] ?? 0;
      const provinceProduction = provinceHourly[hourIndex]?.[resource] ?? 0;
      balances[resource] = previous[resource] + cityProduction + provinceProduction + adjustments[hourIndex][resource];
      endingBalances[resource] = balances[resource];
    }
    balancesByHour.push(balances);
  }

  const cityNextFreeRelHour = Object.fromEntries(
    cities.map(city => {
      const citySegments = segmentsByCity.get(city.cityId);
      const lastCompletionAbsHour = citySegments
        ? Object.values(citySegments)
            .flatMap(list => list)
            .reduce((latest, segment) => Math.max(latest, segment.endMinute / 60), scenarioAbsHour)
        : scenarioAbsHour;
      return [city.cityId, lastCompletionAbsHour - scenarioAbsHour];
    })
  ) as Record<string, number>;

  return {
    feasible: balancesByHour.every(balance => RESOURCE_KEYS.every(resource => balance[resource] >= 0)),
    timedOrder,
    balancesByHour,
    endingBalances,
    cityNextFreeRelHour,
  };
}

const baseline = evaluateTimedOrder([]);

function rank(tokens: CountryTokenAction[], evaluation: Evaluation): RankedSequence {
  const deltas = zeroResources();
  for (const resource of RESOURCE_KEYS) {
    deltas[resource] = evaluation.endingBalances[resource] - baseline.endingBalances[resource];
  }
  const score = RESOURCE_KEYS.reduce(
    (sum, resource) => sum + (deltas[resource] * SCORE_WEIGHTS[resource]),
    0
  );
  return {
    sequenceKey: sequenceKey(tokens),
    sequenceLines: formatSequenceLines(tokens),
    timedOrderLines: formatTimedOrderLines(evaluation.timedOrder),
    timedOrder: evaluation.timedOrder,
    deltas,
    endingBalances: evaluation.endingBalances,
    score,
  };
}

function maxSequenceLength() {
  return country.cities.reduce((sum, city) => {
    const cityId = `${country.country.id}:${city.id}`;
    const pool = poolByCity.get(cityId) ?? [];
    return sum + pool.reduce((inner, buildingId) => inner + (maxDefinedLevel(buildingId) - countryLevelForTokens(city, [], buildingId)), 0);
  }, 0);
}

function countryBeamSearch() {
  const cache = new Map<string, Evaluation>();
  cache.set("", baseline);

  function evaluateTokens(tokens: CountryTokenAction[]) {
    const key = sequenceKey(tokens);
    const cached = cache.get(key);
    if (cached) return cached;

    let timedOrder: BuildAction[] = [];
    let currentEvaluation = baseline;
    const currentTokens: CountryTokenAction[] = [];

    for (const token of tokens) {
      currentTokens.push(token);
      const prefixKey = sequenceKey(currentTokens);
      const prefixCached = cache.get(prefixKey);
      if (prefixCached) {
        timedOrder = prefixCached.timedOrder;
        currentEvaluation = prefixCached;
        continue;
      }

      const cost = levelData(token.buildingId, token.targetLevel).cost;
      const minStartHour = Math.ceil(currentEvaluation.cityNextFreeRelHour[token.cityId] ?? 0);
      let scheduledStartHour: number | undefined;
      for (let hour = minStartHour; hour < hoursToSimulate; hour++) {
        const available = currentEvaluation.balancesByHour[hour] ?? zeroResources();
        if (RESOURCE_KEYS.every(resource => available[resource] >= (cost[resource] ?? 0))) {
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
          cityNextFreeRelHour: currentEvaluation.cityNextFreeRelHour,
        };
        cache.set(prefixKey, failed);
        return failed;
      }

      timedOrder = [
        ...timedOrder,
        {
          cityId: token.cityId,
          buildingId: token.buildingId,
          targetLevel: token.targetLevel,
          startHour: scheduledStartHour,
        },
      ];
      currentEvaluation = evaluateTimedOrder(timedOrder);
      cache.set(prefixKey, currentEvaluation);
    }

    return currentEvaluation;
  }

  function nextActions(tokens: CountryTokenAction[]) {
    return country.cities.flatMap(city => {
      const cityId = `${country.country.id}:${city.id}`;
      const pool = poolByCity.get(cityId) ?? [];
      return pool.flatMap(buildingId => {
        const currentLevel = countryLevelForTokens(city, tokens, buildingId);
        if (currentLevel >= maxDefinedLevel(buildingId)) return [];
        return [{
          cityId,
          cityName: city.name,
          buildingId,
          targetLevel: currentLevel + 1,
        } satisfies CountryTokenAction];
      });
    });
  }

  const seen = new Set<string>([""]);
  let frontier: CandidatePlan[] = [{
    tokens: [],
    evaluation: baseline,
    ranked: rank([], baseline),
  }];
  const allRanked = new Map<string, RankedSequence>();
  const totalDepth = maxSequenceLength();

  for (let depth = 1; depth <= totalDepth; depth++) {
    const candidates = new Map<string, CandidatePlan>();
    for (const plan of frontier) {
      for (const action of nextActions(plan.tokens)) {
        const tokens = [...plan.tokens, action];
        const key = sequenceKey(tokens);
        if (seen.has(key)) continue;
        seen.add(key);

        const evaluation = evaluateTokens(tokens);
        if (!evaluation.feasible) continue;

        const ranked = rank(tokens, evaluation);
        allRanked.set(key, ranked);
        candidates.set(key, { tokens, evaluation, ranked });
      }
    }

    if (candidates.size === 0) break;

    frontier = Array.from(candidates.values())
      .sort((a, b) => compareRanked(a.ranked, b.ranked))
      .slice(0, beamWidth);

    if (!isMarkdownOutput && progressEveryDepth > 0 && depth % progressEveryDepth === 0) {
      const best = frontier[0]?.ranked;
      console.log(
        `[beam-country] depth ${depth}/${totalDepth}, frontier ${frontier.length}, best score ${best?.score ?? 0}`
      );
      if (best) {
        console.log("[beam-country] current best sequence:");
        for (const line of best.sequenceLines) console.log(line);
      }
    }
  }

  return {
    explored: seen.size - 1,
    top: Array.from(allRanked.values()).sort(compareRanked).slice(0, topN),
  };
}

const result = countryBeamSearch();
function printMarkdownOutput() {
  console.log("# Country Beam Search");
  console.log("");
  console.log("## Summary");
  console.log("");
  printMarkdownTable([{
    scenario: `${scenario.id} (${scenario.speed})`,
    country: country.country.name,
    windowDays: daysToSimulate,
    beamWidth,
    exploredFeasibleSequences: result.explored,
    includeRelocateHeadquarters,
    hqCityIds: includeRelocateHeadquarters ? [...hqCityIds].join(", ") : "",
    ranking: "balanced economy proxy",
  }]);
  console.log("");
  console.log("## Assumptions");
  console.log("");
  printMarkdownList([
    "Pooled country balances are used across all cities.",
    "Each city keeps its own build queue timing.",
    "Provinces contribute baseline income but are not built up.",
    "Ranking uses a balanced economy proxy.",
    "Weights: supplies 1, components 1, fuel 1, rares 1, electronics 1, cash 0.25, manpower 0.25.",
    includeRelocateHeadquarters
      ? `relocate_headquarters is allowed for: ${[...hqCityIds].join(", ")}.`
      : "relocate_headquarters is excluded.",
  ]);
  console.log("");
  console.log("## Top Sequences");
  console.log("");
  printMarkdownTable(
    result.top.map((entry, index) => ({
      rank: index + 1,
      score: entry.score,
      delta_supplies: entry.deltas.supplies,
      delta_components: entry.deltas.components,
      delta_fuel: entry.deltas.fuel,
      delta_rares: entry.deltas.rares,
      delta_electronics: entry.deltas.electronics,
      delta_cash: entry.deltas.cash,
      delta_manpower: entry.deltas.manpower,
      sequence: entry.sequenceLines.join("<br>"),
      timedOrder: entry.timedOrderLines.join("<br>"),
    }))
  );
}

const htmlArtifactPath = writeHtmlArtifact();
const topPlan = result.top[0];
const buildPlanPath = topPlan ? writeBuildPlanArtifact(topPlan) : null;
const ecoProjPath = topPlan ? writeEcoProjArtifact(topPlan) : null;

if (isMarkdownOutput) {
  printMarkdownOutput();
  console.error(`[beam-country] html written to ${htmlArtifactPath}`);
  if (buildPlanPath) console.error(`[beam-country] build plan written to ${buildPlanPath}`);
  if (ecoProjPath) console.error(`[beam-country] eco projection written to ${ecoProjPath}`);
} else {
  console.log("Elite WW3 country beam search");
  console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
  console.log(`Country: ${country.country.name}`);
  console.log(`Window: ${daysToSimulate} days (${hoursToSimulate} hours)`);
  console.log(`Beam width: ${beamWidth}`);
  console.log("Assumptions:");
  console.log("- pooled country balances are used across all cities");
  console.log("- each city keeps its own build queue timing");
  console.log("- provinces contribute baseline income but are not built up");
  console.log("- ranking uses a balanced economy proxy");
  console.log("- weights: supplies 1, components 1, fuel 1, rares 1, electronics 1, cash 0.25, manpower 0.25");
  console.log(
    includeRelocateHeadquarters
      ? `- relocate_headquarters is allowed for: ${[...hqCityIds].join(", ")}`
      : "- relocate_headquarters is excluded"
  );

  console.log(`Explored feasible sequences: ${result.explored}`);
  console.log("Top sequences:");
  result.top.forEach((entry, index) => {
    console.log(`Rank ${index + 1}`);
    console.log(`Score: ${entry.score}`);
    for (const resource of RESOURCE_KEYS) {
      console.log(`Delta ${resource}: ${entry.deltas[resource]}`);
    }
    console.log("Sequence:");
    for (const line of entry.sequenceLines) console.log(line);
    console.log("Timed order:");
    for (const line of entry.timedOrderLines) console.log(line);
    console.log("");
  });
  console.error(`[beam-country] html written to ${htmlArtifactPath}`);
  if (buildPlanPath) console.error(`[beam-country] build plan written to ${buildPlanPath}`);
  if (ecoProjPath) console.error(`[beam-country] eco projection written to ${ecoProjPath}`);
}
