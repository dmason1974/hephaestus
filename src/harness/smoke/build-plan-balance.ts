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
import { loadBuildPlanFile } from "../../scenarios/io/load-build-plan.js";
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

type BuildPlanBuildingId =
  | "army_base"
  | "air_base"
  | "annex_city"
  | "arms_industry"
  | "combat_outpost"
  | "local_industry"
  | "naval_base"
  | "recruiting_office"
  | "relocate_headquarters"
  | "underground_bunkers";

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

const planFilePath = path.resolve(
  process.env.BPB_PLAN_FILE?.trim() || "data/scenarios/elite_ww3_2026/plans/indonesia_beam_city_build.yml"
);
const daysToSimulate = parsePositiveInt(process.env.BPB_DAYS, 28);
const cityStatus = parseCityStatus(process.env.BPB_CITY_STATUS);
const outputFilePath = path.resolve(
  process.env.BPB_OUTPUT_FILE?.trim() || "tmp/build-plan-balance.html"
);
const hoursToSimulate = daysToSimulate * 24;

const plan = loadBuildPlanFile(planFilePath);
const scenario = loadScenarioFile(plan.scenario);
const country = loadScenarioCountry(plan.scenario, plan.country);
const buildings = loadBuildingsFile(path.resolve("data/buildings.yml"));
const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);

function levelData(buildingId: BuildPlanBuildingId, level: number) {
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
    cityStatus,
    buildings: {
      army_base: city.starting.army_base,
      air_base: city.starting.air_base,
      annex_city: 0,
      arms_industry: city.starting.arms_industry,
      combat_outpost: 0,
      local_industry: 0,
      naval_base: city.starting.naval_base,
      recruiting_office: city.starting.recruiting_office,
      relocate_headquarters: 0,
      underground_bunkers: city.starting.underground_bunkers,
    },
  };
}

const cityStateById = new Map(country.cities.map(city => [city.id, buildCityState(city)]));
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

const buildOrder: BuildAction[] = plan.city_plans.flatMap(cityPlan => {
  const cityState = cityStateById.get(cityPlan.cityId);
  if (!cityState) {
    throw new Error(`Unknown cityId ${cityPlan.cityId} in ${planFilePath}`);
  }
  return cityPlan.build_order.map(step => ({
    cityId: cityState.cityId,
    buildingId: step.buildingId as BuildPlanBuildingId,
    targetLevel: step.targetLevel,
    startHour: step.start_hour,
  }));
});

const allCityStates = Array.from(cityStateById.values());
const combinedSimulation = simulateBuildOrder({
  cities: allCityStates,
  buildOrder,
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

const baselineHourly = baselineCountryTable.rows.map((row, index) => {
  const previous = index === 0 ? undefined : baselineCountryTable.rows[index - 1]?.balances;
  const delta = zeroResources();
  for (const resource of RESOURCE_KEYS) {
    delta[resource] = (row.balances[resource] ?? 0) - (previous?.[resource] ?? scenario.starting_balance[resource] ?? 0);
  }
  return delta;
}).slice(0, hoursToSimulate);

const provinceHourly = baselineHourly.map((countryRow, index) => {
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
  buildOrder,
  buildings,
  scenario,
});

const adjustments = Array.from({ length: hoursToSimulate }, () => zeroResources());
for (const buildingSegments of combinedSegments.values()) {
  for (const [buildingId, segments] of Object.entries(buildingSegments) as Array<[BuildPlanBuildingId, typeof buildingSegments[BuildPlanBuildingId]]>) {
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
  const next = zeroResources();
  for (const resource of RESOURCE_KEYS) {
    const production =
      (combinedSimulation.perHourAggregate[hourIndex]?.production[resource] ?? 0) +
      (provinceHourly[hourIndex]?.[resource] ?? 0);
    next[resource] = previous[resource] + production + adjustments[hourIndex][resource];
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

const cityRows = plan.city_plans.map(cityPlan => ({
  city: cityPlan.cityName,
  resource: cityPlan.resource,
  build_order: cityPlan.build_order
    .map((step, index) => `${index + 1}. ${step.buildingId} level ${step.targetLevel} @ hour ${step.start_hour}`)
    .join("\n"),
}));

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Build Plan Balance</title><style>
body{font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.4;padding:24px;max-width:1600px;margin:0 auto}
table{border-collapse:collapse;width:100%;margin:12px 0 24px}
th,td{border:1px solid #d0d7de;padding:8px 10px;vertical-align:top;text-align:left}
th{background:#f6f8fa}
h1,h2{margin:20px 0 8px}
</style></head><body>
<h1>Build Plan Balance</h1>
${htmlTable([{
  scenario: `${scenario.id} (${scenario.speed})`,
  country: country.country.name,
  cityStatus,
  windowDays: daysToSimulate,
  plan: planFilePath,
}])}
<h2>City Plans</h2>
${htmlTable(cityRows)}
<h2>Daily Country Balances</h2>
${htmlTable(dailyRows)}
</body></html>`;

fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
fs.writeFileSync(outputFilePath, html, "utf8");

console.log("Build plan balance");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(`Country: ${country.country.name}`);
console.log(`City status: ${cityStatus}`);
console.log(`Window: ${daysToSimulate} days`);
console.log(`Plan: ${planFilePath}`);
console.log("Daily country balances:");
console.table(dailyRows);
console.error(`[build-plan-balance] html written to ${outputFilePath}`);
