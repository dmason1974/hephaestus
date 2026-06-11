import fs from "node:fs";
import path from "node:path";

import type { Resource } from "../../core/constants.js";
import { scenarioStartAbsoluteHour, toAbsoluteHour } from "../../core/time.js";
import { runCityEcoBeam } from "../../engine/eco/city-eco-beam.js";
import { runProvinceEcoBeam } from "../../engine/eco/province-eco-beam.js";
import type { BuildAction } from "../../engine/orchestration/build-order-timeline.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioCoalitionPlan } from "../../scenarios/io/load-coalition-plan.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { getScenarioCountriesDir } from "../../scenarios/paths.js";
import type { CoalitionForcePlan } from "../../schemas/coalition-force-plan-schema.js";
import { scenarioTruceLengthDays } from "../../schemas/scenario-schema.js";

// ── Config ────────────────────────────────────────────────────────────────────

const scenarioId = process.env.ECO_SCENARIO ?? "elite/antarctica";
const planId = process.env.ECO_PLAN;
const countryFilter = process.env.ECO_COUNTRY ?? "all";
const beamWidth = parsePositiveInt(process.env.ECO_BEAM_WIDTH, 50);
const topN = parsePositiveInt(process.env.ECO_TOP_N, 3);

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── Data loading ──────────────────────────────────────────────────────────────

const plan: CoalitionForcePlan | undefined = planId
  ? loadScenarioCoalitionPlan(scenarioId, planId)
  : undefined;
const scenario = loadScenarioFile(scenarioId);
const buildings = loadBuildingsFile(path.resolve("data/buildings.yml"));
const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);

const truceDays = plan?.truce_days ?? scenarioTruceLengthDays(scenario) ?? 28;
const hoursToSimulate = truceDays * 24;

const RESOURCE_KEYS: Resource[] = ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"];
const POOLED_RESOURCES: Resource[] = ["supplies", "components", "fuel", "rares", "electronics", "cash"];

// ── HTML helpers ──────────────────────────────────────────────────────────────

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtAbsHour(absHour: number): string {
  const day = Math.floor(absHour / 24) + 1;
  const hour = Math.floor(absHour % 24);
  return `day ${day} h${String(hour).padStart(2, "0")}`;
}

function fmtRelHour(relHour: number): string {
  return fmtAbsHour(relHour + scenarioAbsHour);
}

function fmtAction(action: BuildAction): string {
  const relH = action.startHour ?? 0;
  const absH = relH + scenarioAbsHour;
  const day = Math.floor(absH / 24) + 1;
  const hour = Math.floor(absH % 24);
  const buildingLabel = action.buildingId.replaceAll("_", " ");
  return `L${action.targetLevel} ${buildingLabel} @ day ${day} h${String(hour).padStart(2, "0")}`;
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

// ── Per-country analysis ──────────────────────────────────────────────────────

function zeroResources(): Record<Resource, number> {
  return { supplies: 0, components: 0, fuel: 0, rares: 0, electronics: 0, cash: 0, manpower: 0 };
}

function analyseCountry(countryId: string): string {
  const country = loadScenarioCountry(scenarioId, countryId);
  const status = country.country.status as "homeland" | "occupied";
  const captureAbsHour = status === "occupied" ? toAbsoluteHour(4, 0) : undefined;

  console.log(`[${countryId}] Running unconstrained eco beam (${country.cities.length} cities, status=${status})...`);

  const ecoResult = runCityEcoBeam(
    country,
    scenario,
    buildings,
    {
      hoursToSimulate,
      beamWidth,
      topN,
      unconstrained: true,
    },
    status,
    undefined,
    captureAbsHour
  );

  const provinceResults = runProvinceEcoBeam(country, scenario, buildings, {
    hoursToSimulate,
    cityStatus: status,
  });

  const countryName = country.country.name;
  const doctrine = country.country.doctrine;

  let html = `<h1>${escapeHtml(countryName)}</h1>
<p class="label">Doctrine: ${escapeHtml(doctrine)} · Status: <span class="${status}">${status}</span> · Truce: ${truceDays} days · Beam width: ${beamWidth}</p>`;

  if (status === "occupied") {
    const captureDay = captureAbsHour !== undefined ? Math.floor((captureAbsHour) / 24) + 1 : "?";
    html += `<p class="label">Occupied: captured day ${captureDay}; annex_city (18h) is the mandatory first build after capture.</p>`;
  }

  html += `\n<h2>City Eco Build Plans</h2>\n`;

  // Build table: one row per city
  const seqRows: string[] = [];
  seqRows.push(`<tr>
    <th>City</th>
    <th>Resource</th>
    <th>Eco Build Sequence</th>
    <th>Last build completes</th>
    <th>Explored</th>
  </tr>`);

  for (const cityResult of ecoResult.cityResults) {
    const isCapital = cityResult.capital;
    const cityLabel = isCapital ? `★ ${cityResult.cityName}` : cityResult.cityName;
    const actions = cityResult.bestActions;
    const seqLines = actions.length === 0
      ? "(no builds)"
      : actions.map(fmtAction).join("\n");

    const lastBuildRelH = cityResult.lastEcoBuildCompletionAbsHour - scenarioAbsHour;
    const lastBuildStr = lastBuildRelH > 0 ? fmtRelHour(lastBuildRelH) : "—";

    seqRows.push(`<tr>
      <td class="${isCapital ? "capital" : ""}">${escapeHtml(cityLabel)}</td>
      <td>${escapeHtml(cityResult.resource)}</td>
      <td><div class="seq">${escapeHtml(seqLines)}</div></td>
      <td>${escapeHtml(lastBuildStr)}</td>
      <td>${cityResult.explored}</td>
    </tr>`);
  }

  html += `<table>${seqRows.join("")}</table>`;

  // Province build plans
  if (provinceResults.length > 0) {
    html += `\n<h2>Province Eco Build Plans</h2>\n`;
    const provRows: string[] = [];
    provRows.push(`<tr>
      <th>Cohort</th>
      <th>Resource</th>
      <th>Provinces</th>
      <th>Eco Build Sequence</th>
    </tr>`);
    for (const pr of provinceResults) {
      const seqStr = pr.bestActions.length === 0
        ? "(no builds)"
        : pr.bestActions.map(a => `L${a.targetLevel} ${a.buildingId.replaceAll("_", " ")}`).join(" → ");
      provRows.push(`<tr>
        <td>${escapeHtml(pr.cohortId.split(":")[1] ?? pr.cohortId)}</td>
        <td>${escapeHtml(pr.resource ?? "—")}</td>
        <td style="text-align:center">${pr.provinceCount}</td>
        <td>${escapeHtml(seqStr)}</td>
      </tr>`);
    }
    html += `<table>${provRows.join("")}</table>`;
  }

  // Production summary table
  html += `\n<h2>City Production Summary (full ${truceDays}-day eco window)</h2>\n`;
  html += `<p class="label">Total resource flow per city over the full truce window (gross production; does not net out build costs). Manpower is not pooled.</p>\n`;

  const summaryRows: string[] = [];
  summaryRows.push(`<tr>
    <th>City</th>
    <th>Resource</th>
    ${RESOURCE_KEYS.map(r => `<th>${r}</th>`).join("")}
  </tr>`);

  const countryTotal = zeroResources();

  for (const cityResult of ecoResult.cityResults) {
    const cityTotal = zeroResources();
    for (const hourly of cityResult.hourlyCityProduction) {
      for (const r of RESOURCE_KEYS) cityTotal[r] += hourly[r] ?? 0;
    }
    for (const r of RESOURCE_KEYS) countryTotal[r] += cityTotal[r];

    const isCapital = cityResult.capital;
    const cityLabel = isCapital ? `★ ${cityResult.cityName}` : cityResult.cityName;
    summaryRows.push(`<tr>
      <td class="${isCapital ? "capital" : ""}">${escapeHtml(cityLabel)}</td>
      <td>${escapeHtml(cityResult.resource)}</td>
      ${RESOURCE_KEYS.map(r => `<td>${fmt(Math.round(cityTotal[r]))}</td>`).join("")}
    </tr>`);
  }

  // Province rows
  for (const pr of provinceResults) {
    for (const r of RESOURCE_KEYS) countryTotal[r] += pr.totalProduction[r] ?? 0;
    const cohortLabel = pr.cohortId.split(":")[1] ?? pr.cohortId;
    summaryRows.push(`<tr>
      <td class="label">${escapeHtml(cohortLabel)}</td>
      <td>${escapeHtml(pr.resource ?? "—")}</td>
      ${RESOURCE_KEYS.map(r => `<td>${fmt(Math.round(pr.totalProduction[r] ?? 0))}</td>`).join("")}
    </tr>`);
  }

  // Country total row
  summaryRows.push(`<tr style="font-weight:bold;background:#f8f8f8">
    <td colspan="2">Total (cities + provinces)</td>
    ${RESOURCE_KEYS.map(r => `<td>${fmt(Math.round(countryTotal[r]))}</td>`).join("")}
  </tr>`);

  html += `<table>${summaryRows.join("")}</table>`;

  // Build cost summary
  html += `\n<h2>Eco Build Costs</h2>\n`;
  html += `<p class="label">One-time resource costs for all eco builds (deducted from the coalition pool).</p>\n`;

  const costRows: string[] = [];
  costRows.push(`<tr>
    <th>City</th>
    <th>Resource</th>
    ${POOLED_RESOURCES.map(r => `<th>${r}</th>`).join("")}
    <th>manpower</th>
  </tr>`);

  const totalCost = zeroResources();

  for (const cityResult of ecoResult.cityResults) {
    const cost = cityResult.totalEcoBuildCost;
    const hasAnyCost = RESOURCE_KEYS.some(r => (cost[r] ?? 0) > 0);
    if (!hasAnyCost) continue;
    for (const r of RESOURCE_KEYS) totalCost[r] += cost[r] ?? 0;

    const isCapital = cityResult.capital;
    const cityLabel = isCapital ? `★ ${cityResult.cityName}` : cityResult.cityName;
    costRows.push(`<tr>
      <td class="${isCapital ? "capital" : ""}">${escapeHtml(cityLabel)}</td>
      <td>${escapeHtml(cityResult.resource)}</td>
      ${POOLED_RESOURCES.map(r => `<td>${fmt(Math.round(cost[r] ?? 0))}</td>`).join("")}
      <td>${fmt(Math.round(cost.manpower ?? 0))}</td>
    </tr>`);
  }

  for (const pr of provinceResults) {
    const cost = pr.totalEcoBuildCost;
    const hasAnyCost = RESOURCE_KEYS.some(r => (cost[r] ?? 0) > 0);
    if (!hasAnyCost) continue;
    for (const r of RESOURCE_KEYS) totalCost[r] += cost[r] ?? 0;
    const cohortLabel = pr.cohortId.split(":")[1] ?? pr.cohortId;
    costRows.push(`<tr>
      <td class="label">${escapeHtml(cohortLabel)}</td>
      <td>${escapeHtml(pr.resource ?? "—")}</td>
      ${POOLED_RESOURCES.map(r => `<td>${fmt(Math.round(cost[r] ?? 0))}</td>`).join("")}
      <td>${fmt(Math.round(cost.manpower ?? 0))}</td>
    </tr>`);
  }

  costRows.push(`<tr style="font-weight:bold;background:#f8f8f8">
    <td colspan="2">Total</td>
    ${POOLED_RESOURCES.map(r => `<td>${fmt(Math.round(totalCost[r]))}</td>`).join("")}
    <td>${fmt(Math.round(totalCost.manpower))}</td>
  </tr>`);

  html += `<table>${costRows.join("")}</table>`;

  return html;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function resolveCountryIds(): string[] {
  if (countryFilter !== "all") return [countryFilter];
  if (plan) return Object.keys(plan.countries);
  // No plan: scan the countries directory for all country YAMLs
  const countriesDir = getScenarioCountriesDir(scenarioId);
  return fs
    .readdirSync(countriesDir)
    .filter(f => f.endsWith(".yml"))
    .map(f => path.basename(f, ".yml"))
    .sort();
}

const countryIds = resolveCountryIds();

for (const countryId of countryIds) {
  const body = analyseCountry(countryId);
  const country = loadScenarioCountry(scenarioId, countryId);
  const title = `Eco Plan — ${country.country.name}`;
  const html = buildHtml(title, body);
  const outPath = path.resolve(`tmp/eco-${countryId}.html`);
  fs.writeFileSync(outPath, html, "utf8");
  console.log(`  → wrote ${outPath}`);
}
