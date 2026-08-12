import fs from "node:fs";
import path from "node:path";

import type { Resource } from "../../core/constants.js";
import { POOLED_RESOURCES } from "../../core/constants.js";
import { scenarioStartAbsoluteHour, toAbsoluteHour } from "../../core/time.js";
import { runCityEcoBeam } from "../../engine/eco/city-eco-beam.js";
import { computeCountryForceProjection } from "../../engine/optimization/country-force-projection.js";
import { computeGarrisonUpkeep } from "../../engine/optimization/garrison-upkeep.js";
import type { ResourceCost } from "../../engine/optimization/types.js";
import {
  computeCountryResourceBalance,
  computeCoalitionResourceBalance,
  type CountryResourceBalance,
} from "../../engine/reporting/coalition-resource-balance.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioCoalitionPlan } from "../../scenarios/io/load-coalition-plan.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadMergedUnitCatalogForScenario } from "../../scenarios/io/load-unit-catalog.js";

// ── Config ────────────────────────────────────────────────────────────────────

const scenarioId = process.env.RP_SCENARIO ?? "elite/antarctica";
const planId = process.env.RP_PLAN;
if (!planId) {
  throw new Error("RP_PLAN is required (e.g. RP_PLAN=pnth-v-iron-2026-aug) — this harness produces the coalition's real balance sheet, so it refuses to silently fall back to a stale default plan.");
}
const countryFilter = process.env.RP_COUNTRY ?? "all";
const maxRoLevel = parsePositiveInt(process.env.RP_MAX_RO, 5);
const beamWidth = parsePositiveInt(process.env.RP_BEAM_WIDTH, 50);
const topN = parsePositiveInt(process.env.RP_TOP_N, 3);
const garrisonDisbandDay = parsePositiveInt(process.env.RP_GARRISON_DISBAND_DAY, 4);
const outputFilePath = path.resolve(process.env.RP_OUTPUT_FILE?.trim() ?? "tmp/resource-projection.html");

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── Data loading ──────────────────────────────────────────────────────────────

const plan = loadScenarioCoalitionPlan(scenarioId, planId);
const scenario = loadScenarioFile(scenarioId);
const buildings = loadBuildingsFile(path.resolve("data/buildings.yml"));
const catalog = loadMergedUnitCatalogForScenario(scenarioId);
const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
const deadlineAbsHour = scenarioAbsHour + plan.truce_days * 24;
const hoursToSimulate = plan.truce_days * 24;

const RESOURCE_KEYS: Resource[] = ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"];

// ── HTML helpers ────────────────────────────────────────────────────────────

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function fmtAbsHour(h: number): string {
  const day = Math.floor(h / 24) + 1;
  const hour = Math.floor(h % 24);
  return `day ${day} h${String(hour).padStart(2, "0")}`;
}

function htmlTable(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0) return "<p><em>None</em></p>\n";
  const headers = columns ?? Object.keys(rows[0]);
  const head = `<tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
  const body = rows.map(row => `<tr>${headers.map(h => `<td>${escapeHtml(row[h])}</td>`).join("")}</tr>`).join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>\n`;
}

/** Renders a labelled balance sheet table where the net row has red/green coloured cells. */
function htmlBalanceSheet(rows: Array<{ label: string; values: Record<Resource, number> }>, netRowLabel: string, resources: Resource[]): string {
  const head = `<tr><th></th>${resources.map(r => `<th>${escapeHtml(r)}</th>`).join("")}</tr>`;
  const body = rows.map(row => {
    const isNet = row.label === netRowLabel;
    const labelCell = `<td><strong>${escapeHtml(row.label)}</strong></td>`;
    const dataCells = resources.map(r => {
      const v = row.values[r] ?? 0;
      const text = fmt(v);
      if (isNet) {
        const style = v < 0 ? ` style="color:#cf222e;font-weight:600"` : v > 0 ? ` style="color:#1a7f37;font-weight:600"` : "";
        return `<td${style}>${escapeHtml(text)}</td>`;
      }
      return `<td>${escapeHtml(text)}</td>`;
    });
    return `<tr>${labelCell}${dataCells.join("")}</tr>`;
  }).join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>\n`;
}

function buildHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: ui-monospace,"Cascadia Code","Fira Mono","Courier New",monospace; font-size: 12px; margin: 1rem 2rem; }
  h1 { font-size: 1.3rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1rem; margin: 1.5rem 0 0.4rem; border-bottom: 1px solid #ccc; }
  table { border-collapse: collapse; margin-bottom: 0.8rem; }
  th, td { border: 1px solid #ccc; padding: 3px 8px; text-align: right; white-space: nowrap; }
  th { background: #f0f0f0; text-align: center; font-size: 11px; }
  td:first-child, th:first-child { text-align: left; }
  .label { color: #666; font-size: 11px; }
  .surplus { color: #1a7f37; font-weight: 600; }
  .deficit { color: #cf222e; font-weight: 600; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

// ── Per-country analysis ───────────────────────────────────────────────────

function analyseCountry(countryId: string): CountryResourceBalance {
  const country = loadScenarioCountry(scenarioId, countryId);
  const doctrine = country.country.doctrine;
  const countryPlan = plan.countries[countryId];
  const status = countryPlan?.status ?? "homeland";
  const captureDay = countryPlan?.capture_day ?? 4;
  const captureAbsHour = status === "occupied" ? toAbsoluteHour(captureDay, 0) : undefined;

  console.log(`[${countryId}] running eco beam + force projection (status=${status})...`);

  const ecoResult = runCityEcoBeam(
    country, scenario, buildings,
    { hoursToSimulate, beamWidth, topN, unconstrained: true },
    status, undefined, captureAbsHour,
  );

  const forceProjection = computeCountryForceProjection({
    country, doctrine, status,
    demands: countryPlan?.demands ?? [],
    scenario, buildings, catalog,
    scenarioAbsHour, deadlineAbsHour,
    truceDays: plan.truce_days,
    maxRoLevel,
  });

  const ecoBuildCost: ResourceCost = {};
  for (const city of ecoResult.cityResults) {
    for (const [r, amount] of Object.entries(city.totalEcoBuildCost)) {
      if (amount) ecoBuildCost[r as Resource] = (ecoBuildCost[r as Resource] ?? 0) + amount;
    }
  }

  const garrisonUpkeep = status === "homeland"
    ? computeGarrisonUpkeep(scenario, catalog, doctrine, scenarioAbsHour, toAbsoluteHour(garrisonDisbandDay, 0))
    : { hours: 0, totalUpkeep: {}, units: [] };

  const startingBalance = status === "homeland" ? (country.starting_balance ?? {}) : {};

  return computeCountryResourceBalance({
    countryId,
    countryName: country.country.name,
    doctrine,
    catalog,
    scenarioAbsHour,
    hoursToSimulate,
    cityResults: ecoResult.cityResults,
    forceProjection,
    ecoBuildCost,
    garrisonUpkeep,
    startingBalance,
  });
}

function zeroResources(): Record<Resource, number> {
  return { supplies: 0, components: 0, fuel: 0, rares: 0, electronics: 0, cash: 0, manpower: 0 };
}

function renderCountryHtml(balance: CountryResourceBalance): string {
  let html = `<h1>${escapeHtml(balance.countryName)}</h1>\n`;
  html += `<h2>Country Balance Sheet</h2>\n`;
  html += `<p class="label">Manpower is not pooled — checked per-country only.</p>\n`;
  html += htmlBalanceSheet([
    { label: "Eco income (flip-truncated)", values: balance.ecoIncome },
    { label: "+ Starting balance", values: balance.startingBalance },
    { label: "− Eco build cost", values: balance.ecoBuildCost },
    { label: "− Force costs (infra + mob + upkeep)", values: balance.forceCosts },
    { label: "− Garrison upkeep", values: balance.garrisonUpkeep },
    { label: "= Net balance", values: balance.netBalance },
  ], "= Net balance", RESOURCE_KEYS);
  return html;
}

// ── Main ───────────────────────────────────────────────────────────────────

fs.mkdirSync(path.resolve("tmp"), { recursive: true });

const countryIds = countryFilter === "all" ? Object.keys(plan.countries) : [countryFilter];

const countryBalances: CountryResourceBalance[] = [];
for (const countryId of countryIds) {
  const balance = analyseCountry(countryId);
  countryBalances.push(balance);

  const html = buildHtml(`Resource Projection — ${balance.countryName}`, renderCountryHtml(balance));
  const outPath = path.resolve(`tmp/rp-${countryId}.html`);
  fs.writeFileSync(outPath, html, "utf8");
  console.log(`  → wrote ${outPath}`);
}

const coalition = computeCoalitionResourceBalance(countryBalances);

let aggBody = `<h1>Coalition Resource Projection</h1>\n`;
aggBody += `<p class="label">Scenario: ${escapeHtml(scenarioId)} · Plan: ${escapeHtml(planId)} · Deadline: ${fmtAbsHour(deadlineAbsHour)} (${plan.truce_days} days) · Garrison disband day ${garrisonDisbandDay}</p>\n`;

aggBody += `<h2>Coalition Balance Sheet (pooled resources)</h2>\n`;
const grossAvailable: Record<Resource, number> = zeroResources();
for (const r of POOLED_RESOURCES) grossAvailable[r] = coalition.pooledEcoIncome[r] + coalition.pooledStartingBalance[r];
aggBody += htmlBalanceSheet([
  { label: "Eco income (flip-truncated)", values: coalition.pooledEcoIncome },
  { label: "+ Starting balance", values: coalition.pooledStartingBalance },
  { label: "= Gross available", values: grossAvailable },
  { label: "− Costs (eco build + force + garrison)", values: coalition.pooledCosts },
  { label: "= Net balance", values: coalition.netPooledBalance },
], "= Net balance", POOLED_RESOURCES);

aggBody += `<h2>Resource Minima (hourly cash-flow walk)</h2>\n`;
aggBody += `<p class="label">Lowest running pooled balance at any hour in the window. Negative = the coalition pool would go insolvent mid-window even if the end-of-window net is positive. Upkeep uses a continuous L1-rate approximation in this walk (vs. the exact stepped rate in the totals above), so treat this as a shortfall detector, not a bit-exact reconciliation of the totals.</p>\n`;
aggBody += htmlTable(
  coalition.resourceMinima.map(m => ({
    resource: m.resource,
    hour: fmtAbsHour(scenarioAbsHour + m.hour),
    value: fmt(m.value),
  })),
  ["resource", "hour", "value"],
);

aggBody += `<h2>Per-Country Manpower Check (not pooled)</h2>\n`;
aggBody += htmlTable(
  coalition.perCountryManpower.map(c => ({
    country: c.countryName,
    manpowerNetBalance: fmt(c.manpowerNetBalance),
  })),
  ["country", "manpowerNetBalance"],
);

fs.writeFileSync(outputFilePath, buildHtml("Coalition Resource Projection", aggBody), "utf8");
console.log(`→ wrote ${outputFilePath}`);
