// Hand-specified "iron" eco heuristic — bypasses the coalition-weight beam entirely.
// Build order per city is explicit (RO1, then arms_industry to a fixed target level
// based on the city's native resource), simulated via the same primitives the beam
// itself uses (scheduleBuildSegments), with no search/optimization anywhere in this
// script. Province build sequences come from the shared IRON heuristic's
// PROVINCE_BUILD_ORDER (resource-keyed, not country-specific).
// Run via IRON_COUNTRY=<id> npm run smoke:iron-eco-plan.
import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_MORALE_DECAY_D,
  HOMELAND_TARGET_MORALE,
  STARTING_MORALE_DAY1,
  type Resource,
} from "../../core/constants.js";
import { scenarioStartAbsoluteHour, toAbsoluteHour } from "../../core/time.js";
import { buildDailyProvinceResourceTable } from "../../engine/economy/province-production.js";
import {
  scheduleBuildSegments,
  type BuildAction,
  type TimelineCityState,
} from "../../engine/orchestration/build-order-timeline.js";
import { buildProvinceCohortsFromCountry } from "../../engine/provinces/province-cohorts.js";
import { simulateBuildOrder, type CityState } from "../../engine/simulation/build-order-sim.js";
import {
  simulateProvinceBuildOrder,
  type ProvinceBuildAction,
} from "../../engine/simulation/province-build-order-sim.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { scenarioTruceLengthDays } from "../../schemas/scenario-schema.js";
import { AI_TARGET_BY_RESOURCE, PROVINCE_BUILD_ORDER } from "./iron-heuristic.js";

const RESOURCE_KEYS: Resource[] = ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"];

function zeroResources(): Record<Resource, number> {
  return { supplies: 0, components: 0, fuel: 0, rares: 0, electronics: 0, cash: 0, manpower: 0 };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

const scenarioId = process.env.IRON_SCENARIO ?? "elite/antarctica";
const countryId = process.env.IRON_COUNTRY;
if (!countryId) {
  throw new Error("IRON_COUNTRY is required, e.g. IRON_COUNTRY=south_africa npm run smoke:iron-eco-plan");
}

const scenario = loadScenarioFile(scenarioId);
const buildings = loadBuildingsFile(path.resolve("data/buildings.yml"));
const country = loadScenarioCountry(scenarioId, countryId);
const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
const truceDays = scenarioTruceLengthDays(scenario) ?? 28;

// ── HTML helpers (copied verbatim from eco-plan.ts so output format matches) ──

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmtAbsHourFromMinute(minute: number): string {
  const absHour = minute / 60;
  const day = Math.floor(absHour / 24) + 1;
  const hour = Math.floor(absHour % 24);
  return `day ${day} h${String(hour).padStart(2, "0")}`;
}

function buildHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: ui-monospace, "Cascadia Code", "Fira Mono", "Courier New", monospace; font-size: 12px; margin: 1rem 2rem; }
  h1 { font-size: 1.3rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1rem; margin: 1.5rem 0 0.4rem; border-bottom: 1px solid #ccc; }
  table { border-collapse: collapse; margin-bottom: 1rem; }
  th, td { border: 1px solid #ccc; padding: 3px 8px; text-align: right; white-space: nowrap; }
  th { background: #f0f0f0; text-align: center; font-size: 11px; }
  td:first-child, th:first-child { text-align: left; }
  .capital { font-weight: bold; }
  .occupied { color: #8b0000; }
  .annexed { color: #6b4000; }
  .surplus { color: #1a7f37; font-weight: 600; }
  .deficit { color: #cf222e; font-weight: 600; }
  .seq { font-size: 11px; white-space: pre-wrap; max-width: 600px; }
  .label { color: #666; font-size: 11px; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

// ── City build plans (explicit, no beam) ───────────────────────────────────────

const cityStates: TimelineCityState[] = country.cities.map(city => ({
  cityId: `${country.country.id}:${city.id}`,
  capital: city.capital,
  cityStatus: "homeland",
  countryId: country.country.id,
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
}));

const buildOrder: BuildAction[] = [];
for (const city of country.cities) {
  const cityId = `${country.country.id}:${city.id}`;
  const aiTarget = AI_TARGET_BY_RESOURCE[city.resource];
  if (aiTarget === undefined) {
    throw new Error(`no AI target rule for resource "${city.resource}" (city ${city.id})`);
  }
  buildOrder.push({ cityId, buildingId: "recruiting_office", targetLevel: 1 });
  buildOrder.push({ cityId, buildingId: "arms_industry", targetLevel: aiTarget });
}

const segmentsByCity = scheduleBuildSegments({ cities: cityStates, buildOrder, buildings, scenario });

let html = `<h1>${escapeHtml(country.country.name)} — Iron Eco Heuristic</h1>
<p class="label">Doctrine: ${escapeHtml(country.country.doctrine)} · Status: homeland · Truce: ${truceDays} days</p>
<p class="label">Hand-specified build order, not the coalition-weight beam: RO1 everywhere, then arms_industry &rarr; L5 for supplies/electronics/rares cities, arms_industry &rarr; L1 only (stop) for components/fuel cities. No further buildings this pass.</p>
`;

html += `\n<h2>City Eco Build Plans</h2>\n`;

const seqRows: string[] = [];
seqRows.push(`<tr>
  <th>City</th>
  <th>Resource</th>
  <th>Eco Build Sequence</th>
  <th>Last build completes</th>
  <th>Explored</th>
</tr>`);

for (const city of country.cities) {
  const cityId = `${country.country.id}:${city.id}`;
  const segs = segmentsByCity.get(cityId);
  const allSegs = [...(segs?.recruiting_office ?? []), ...(segs?.arms_industry ?? [])].sort(
    (a, b) => a.startMinute - b.startMinute
  );

  const seqLines = allSegs.length === 0
    ? "(no builds)"
    : allSegs
        .map(s => `L${s.toLevel} ${s.buildingId.replaceAll("_", " ")} @ ${fmtAbsHourFromMinute(s.startMinute)}`)
        .join("\n");

  const lastCompletionMinute = allSegs.length === 0 ? undefined : Math.max(...allSegs.map(s => s.endMinute));
  const lastBuildStr = lastCompletionMinute === undefined ? "—" : fmtAbsHourFromMinute(lastCompletionMinute);

  const isCapital = city.capital;
  const cityLabel = isCapital ? `★ ${city.name}` : city.name;

  seqRows.push(`<tr>
    <td class="${isCapital ? "capital" : ""}">${escapeHtml(cityLabel)}</td>
    <td>${escapeHtml(city.resource)}</td>
    <td><div class="seq">${escapeHtml(seqLines)}</div></td>
    <td>${escapeHtml(lastBuildStr)}</td>
    <td>manual</td>
  </tr>`);
}

html += `<table>${seqRows.join("")}</table>`;

// ── Province income — computed from the country's real province cohorts ──────
// Rule: supplies/electronics cohorts get PROVINCE_BUILD_ORDER's build sequence;
// every other cohort (components, fuel, rares, non-resource) shown with no build
// investment, base production only (see iron-heuristic.ts for the rationale).

const provinceCohorts = buildProvinceCohortsFromCountry(country);

function provinceSequenceLabel(resource: string | undefined): string {
  const steps = (resource && PROVINCE_BUILD_ORDER[resource]) ?? [];
  return steps.length === 0
    ? "(no builds)"
    : steps.map(s => `L${s.targetLevel} ${s.buildingId.replaceAll("_", " ")}`).join(" → ");
}

html += `\n<h2>Province Eco Build Plans</h2>\n`;
html += `<p class="label">supplies/electronics cohorts get the iron heuristic's build sequence; every other cohort gets no build (base production only).</p>\n`;

const provRows: string[] = [];
provRows.push(`<tr>
  <th>Cohort</th>
  <th>Resource</th>
  <th>Provinces</th>
  <th>Eco Build Sequence</th>
</tr>`);
for (const cohort of provinceCohorts) {
  const cohortLabel = cohort.cohortId.split(":")[1] ?? cohort.cohortId;
  provRows.push(`<tr>
    <td>${escapeHtml(cohortLabel)}</td>
    <td>${escapeHtml(cohort.resource ?? "—")}</td>
    <td style="text-align:center">${cohort.totalProvinceCount}</td>
    <td>${escapeHtml(provinceSequenceLabel(cohort.resource))}</td>
  </tr>`);
}
html += `<table>${provRows.join("")}</table>`;

// ── Resource yield (full truce window) — direct simulation, no beam search ────
// City yield: same explicit buildOrder as above, run through the full window.
// Province yield: fixed simulation per cohort — PROVINCE_BUILD_ORDER's sequence
// for supplies/electronics, empty build order for every other cohort (no build
// required, base production only).

const hoursToSimulate = truceDays * 24;

const fullCityStates: CityState[] = country.cities.map(city => ({
  cityId: `${country.country.id}:${city.id}`,
  countryId: country.country.id,
  capital: city.capital,
  resource: city.resource,
  startPop: city.population,
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
}));

// Plan mechanic: disbanding the starting-garrison gunships (day 4, see CLAUDE.md's
// "Starting Units — Garrison Mechanic") forces destruction of each capital's original
// airport (air_base level 1) the same day — zeroes the capital's air_base production
// bonus from the end of that day onward. Defaults to day 4; override with
// IRON_AIRPORT_DESTROY_DAY=<day> for what-if variants.
const airportDestroyDay = process.env.IRON_AIRPORT_DESTROY_DAY
  ? Number(process.env.IRON_AIRPORT_DESTROY_DAY)
  : 4;
const forcedAirBaseDestructionAbsHour: Record<string, number> = Object.fromEntries(
  country.cities
    .filter(city => city.capital)
    .map(city => [`${country.country.id}:${city.id}`, toAbsoluteHour(airportDestroyDay + 1, 0)])
);

const citySimulation = simulateBuildOrder({
  cities: fullCityStates,
  buildOrder,
  buildings,
  scenario,
  hoursToSimulate,
  forcedAirBaseDestructionAbsHour,
});

const cityYieldByCity = new Map<string, Record<Resource, number>>();
for (const city of country.cities) {
  cityYieldByCity.set(`${country.country.id}:${city.id}`, zeroResources());
}
for (const row of citySimulation.perHourPerCity) {
  const total = cityYieldByCity.get(row.cityId);
  if (!total) continue;
  for (const r of RESOURCE_KEYS) total[r] += row.production[r] ?? 0;
}

const provinceYieldByCohort: Array<{ cohortId: string; resource: string; provinceCount: number; total: Record<Resource, number> }> = [];
for (const cohort of provinceCohorts) {
  const steps = (cohort.resource && PROVINCE_BUILD_ORDER[cohort.resource]) ?? [];
  const actions: ProvinceBuildAction[] = steps.map(s => ({
    provinceId: cohort.provinceId,
    buildingId: s.buildingId,
    targetLevel: s.targetLevel,
  }));
  const result = simulateProvinceBuildOrder({
    provinces: [{ ...cohort, cityStatus: "homeland" }],
    buildOrder: actions,
    buildings,
    scenario,
    hoursToSimulate,
  });
  const total = zeroResources();
  for (const row of result.perHourAggregate) {
    for (const r of RESOURCE_KEYS) total[r] += row.production[r] ?? 0;
  }

  // Bug workaround (engine, not this script): simulateProvinceBuildOrder computes
  // production hourly via floorInt(dailyAmount / 24), which floors to 0 every hour
  // for any cohort whose per-province daily manpower is small relative to 24 (e.g.
  // 1-province cohorts here — dailyAmount ~7, 7/24 floors to 0 every hour, every
  // day). Recompute manpower from the daily-granularity table instead, which floors
  // once per day and doesn't lose it. Cash/resources aren't affected (large enough
  // base rates to survive the /24 floor), so only manpower is overridden here.
  total.manpower = buildDailyProvinceResourceTable(truceDays, scenario.speed, {
    resource: "manpower",
    provinceCount: cohort.totalProvinceCount,
    moraleParams: {
      S: STARTING_MORALE_DAY1,
      T: HOMELAND_TARGET_MORALE,
      N: 0,
      D: DEFAULT_MORALE_DECAY_D,
    },
    cityStatus: "homeland",
  }).total;

  provinceYieldByCohort.push({
    cohortId: cohort.cohortId,
    resource: cohort.resource ?? "—",
    provinceCount: cohort.totalProvinceCount,
    total,
  });
}

// ── City Production Summary (same table shape as eco-italy.html) ─────────────

html += `\n<h2>City Production Summary (full ${truceDays}-day eco window)</h2>\n`;
html += `<p class="label">Total resource flow over the full truce window under the iron heuristic (gross production; does not net out build costs). Manpower is not pooled.</p>\n`;

const summaryRows: string[] = [];
summaryRows.push(`<tr>
  <th>City</th>
  <th>Resource</th>
  ${RESOURCE_KEYS.map(r => `<th>${r}</th>`).join("")}
</tr>`);

const countryTotal = zeroResources();

for (const city of country.cities) {
  const cityTotal = cityYieldByCity.get(`${country.country.id}:${city.id}`) ?? zeroResources();
  for (const r of RESOURCE_KEYS) countryTotal[r] += cityTotal[r];
  const isCapital = city.capital;
  const cityLabel = isCapital ? `★ ${city.name}` : city.name;
  summaryRows.push(`<tr>
    <td class="${isCapital ? "capital" : ""}">${escapeHtml(cityLabel)}</td>
    <td>${escapeHtml(city.resource)}</td>
    ${RESOURCE_KEYS.map(r => `<td>${fmt(Math.round(cityTotal[r]))}</td>`).join("")}
  </tr>`);
}

for (const pr of provinceYieldByCohort) {
  for (const r of RESOURCE_KEYS) countryTotal[r] += pr.total[r] ?? 0;
  const cohortLabel = pr.cohortId.split(":")[1] ?? pr.cohortId;
  summaryRows.push(`<tr>
    <td class="label">${escapeHtml(cohortLabel)}</td>
    <td>${escapeHtml(pr.resource)}</td>
    ${RESOURCE_KEYS.map(r => `<td>${fmt(Math.round(pr.total[r] ?? 0))}</td>`).join("")}
  </tr>`);
}

summaryRows.push(`<tr style="font-weight:bold;background:#f8f8f8">
  <td colspan="2">Total (cities + provinces)</td>
  ${RESOURCE_KEYS.map(r => `<td>${fmt(Math.round(countryTotal[r]))}</td>`).join("")}
</tr>`);

html += `<table>${summaryRows.join("")}</table>`;

const outHtml = buildHtml(`Iron Eco Plan — ${country.country.name}`, html);
const outPath = path.resolve(`tmp/iron-eco-${countryId}.html`);
fs.writeFileSync(outPath, outHtml, "utf8");
console.log(`→ wrote ${outPath}`);
