import fs from "node:fs";
import path from "node:path";

import type { Resource } from "../../core/constants.js";
import { POOLED_RESOURCES } from "../../core/constants.js";
import { scenarioStartAbsoluteHour, toAbsoluteHour } from "../../core/time.js";
import type { CityEcoResult, CountryEcoBeamResult } from "../../engine/eco/city-eco-beam.js";
import { runActualEcoBuild } from "../../engine/eco/actual-eco-build.js";
import { classifyDemands, computeCountryForceProjection, getBatchSize, type CountryForceProjectionResult } from "../../engine/optimization/country-force-projection.js";
import { computePlanWeights } from "../../engine/optimization/joint-city-optimizer.js";
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
  .skipped { color: #888; font-style: italic; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

// ── Per-country analysis ───────────────────────────────────────────────────

type CountryAnalysis = {
  balance: CountryResourceBalance;
  cityNameMap: Map<string, string>;
  actualEco: CountryEcoBeamResult;
  forceProjection: CountryForceProjectionResult;
};

function analyseCountry(countryId: string): CountryAnalysis {
  const country = loadScenarioCountry(scenarioId, countryId);
  const doctrine = country.country.doctrine;
  const countryPlan = plan.countries[countryId];
  const status = countryPlan?.status ?? "homeland";
  const captureDay = countryPlan?.capture_day ?? 4;
  const captureAbsHour = status === "occupied" ? toAbsoluteHour(captureDay, 0) : undefined;

  console.log(`[${countryId}] running actual eco build (Unit 1.5) + force projection (status=${status})...`);

  const demands = countryPlan?.demands ?? [];
  const { activeDemands } = classifyDemands(demands, doctrine, catalog);
  const planWeights = computePlanWeights(
    activeDemands.map(d => ({ unitId: d.unitId, effectiveCount: Math.ceil(d.count / getBatchSize(d.unitId, catalog)) })),
    catalog, doctrine, plan.truce_days,
  );

  // Unit 1.5: the "actual eco build" — Unit 1's beam engine, weighted by the force
  // plan's real resource footprint, with relocate_headquarters capped to at most
  // one city. This is what drives Unit 3's cost/income accounting below. Unit 1's
  // own unconstrained/theoretical run (smoke:eco-plan) is intentionally not used
  // here — it's a per-city-isolated reference ceiling, not the real plan.
  const actualEco = runActualEcoBuild(
    country, scenario, buildings,
    { hoursToSimulate, beamWidth, topN, unconstrained: true },
    status, captureAbsHour, planWeights,
  );
  const actualEcoResultsByCity = new Map<string, CityEcoResult>(
    actualEco.cityResults.map(r => [r.cityId.slice(r.cityId.indexOf(":") + 1), r]),
  );

  const forceProjection = computeCountryForceProjection({
    country, doctrine, status,
    demands,
    scenario, buildings, catalog,
    scenarioAbsHour, deadlineAbsHour,
    truceDays: plan.truce_days,
    maxRoLevel,
    planWeights,
    actualEcoResultsByCity,
  });

  const ecoBuildCost: ResourceCost = {};
  for (const city of actualEco.cityResults) {
    for (const [r, amount] of Object.entries(city.totalEcoBuildCost)) {
      if (amount) ecoBuildCost[r as Resource] = (ecoBuildCost[r as Resource] ?? 0) + amount;
    }
  }

  const garrisonUpkeep = status === "homeland"
    ? computeGarrisonUpkeep(scenario, catalog, doctrine, scenarioAbsHour, toAbsoluteHour(garrisonDisbandDay, 0))
    : { hours: 0, totalUpkeep: {}, units: [] };

  const startingBalance = status === "homeland" ? (country.starting_balance ?? {}) : {};

  const balance = computeCountryResourceBalance({
    countryId,
    countryName: country.country.name,
    doctrine,
    catalog,
    scenarioAbsHour,
    hoursToSimulate,
    cityResults: actualEco.cityResults,
    forceProjection,
    ecoBuildCost,
    garrisonUpkeep,
    startingBalance,
  });

  const cityNameMap = new Map<string, string>(country.cities.map(c => [c.id, c.name]));

  return { balance, cityNameMap, actualEco, forceProjection };
}

function zeroResources(): Record<Resource, number> {
  return { supplies: 0, components: 0, fuel: 0, rares: 0, electronics: 0, cash: 0, manpower: 0 };
}

// ── Build plan (bp-<country>.html): balance + research + combined infra/mob + force projection ──
// This is the only per-country HTML output — it supersedes the old rp-<country>.html
// (balance-only) whose entire content duplicated this file's section 1.

function resourceCostHeader(): string {
  return `<tr><th></th>${RESOURCE_KEYS.map(r => `<th>${escapeHtml(r)}</th>`).join("")}</tr>`;
}

function resourceCostRow(label: string, cost: ResourceCost): string {
  return `<tr><td>${escapeHtml(label)}</td>${RESOURCE_KEYS.map(r => {
    const v = Math.round(cost[r] ?? 0);
    return `<td>${v !== 0 ? fmt(v) : "—"}</td>`;
  }).join("")}</tr>`;
}

function renderResearchSection(forceProjection: CountryForceProjectionResult): string {
  const rows = forceProjection.researchSegments
    .slice()
    .sort((a, b) => a.slot - b.slot || a.startAbsoluteHour - b.startAbsoluteHour)
    .map(s => ({
      slot: `Slot ${s.slot}`,
      unit: s.unitId.replaceAll("_", " "),
      level: s.level,
      start: fmtAbsHour(s.startAbsoluteHour),
      duration: `${s.durationHours}h`,
    }));
  return htmlTable(rows, ["slot", "unit", "level", "start", "duration"]);
}

/**
 * Merges each city's actual eco build (Unit 1.5) with its force-projection infra
 * chain and mob queue (Unit 2) into one chronological timeline. Eco steps are only
 * included up to what the flip point actually credits (buildingLevelsAtAbsHour) —
 * matching the eco-credit logic buildCityInfraStepsFromEco itself uses — since any
 * later theoretical eco step wouldn't really happen once the city has flipped.
 * Cities with no force-projection slot (pure eco, not producing any demand) show
 * their full eco sequence uncredited/untruncated.
 */
function renderCombinedInfraSection(analysis: CountryAnalysis): string {
  const { cityNameMap, actualEco, forceProjection } = analysis;
  const slotByCityId = new Map(forceProjection.citySlots.map(s => [s.cityId, s]));

  // HQ is the capital by default, but relocate_headquarters (capped to at most one
  // city — see actual-eco-build.ts) can move it; whichever city actually built it
  // is the real current HQ.
  const relocatedHq = actualEco.cityResults.find(r => r.bestActions.some(a => a.buildingId === "relocate_headquarters"));
  const hqCityId = relocatedHq?.cityId ?? actualEco.cityResults.find(r => r.capital)?.cityId;

  const sortedCityResults = actualEco.cityResults.slice().sort((a, b) => {
    const nameA = cityNameMap.get(a.cityId.slice(a.cityId.indexOf(":") + 1)) ?? a.cityId;
    const nameB = cityNameMap.get(b.cityId.slice(b.cityId.indexOf(":") + 1)) ?? b.cityId;
    return nameA.localeCompare(nameB);
  });

  let html = "";
  for (const cityEco of sortedCityResults) {
    const bareCityId = cityEco.cityId.slice(cityEco.cityId.indexOf(":") + 1);
    const cName = cityNameMap.get(bareCityId) ?? bareCityId;
    const slot = slotByCityId.get(bareCityId);
    const hqMarker = cityEco.cityId === hqCityId ? "★ " : "";

    const rows: Array<{ absHour: number; step: string }> = [];

    if (slot) {
      const creditedLevels = cityEco.buildingLevelsAtAbsHour(slot.flipPointAbsHour) as Record<string, number | undefined>;
      for (const a of cityEco.bestActions) {
        if ((creditedLevels[a.buildingId] ?? 0) >= a.targetLevel) {
          rows.push({ absHour: (a.startHour ?? 0) + scenarioAbsHour, step: `[eco] ${a.buildingId.replaceAll("_", " ")} L${a.targetLevel}` });
        }
      }
      rows.push({ absHour: slot.flipPointAbsHour, step: `→ FLIP — eco to military` });
      for (const s of slot.infraSteps) {
        rows.push({ absHour: s.startHour, step: `[infra] ${s.name}` });
      }
      for (const m of slot.mobSteps) {
        rows.push({ absHour: m.startAbsHour, step: `[mob] ${m.unitId.replaceAll("_", " ")} ×${m.count}` });
      }
    } else {
      for (const a of cityEco.bestActions) {
        rows.push({ absHour: (a.startHour ?? 0) + scenarioAbsHour, step: `[eco] ${a.buildingId.replaceAll("_", " ")} L${a.targetLevel}` });
      }
    }

    rows.sort((a, b) => a.absHour - b.absHour);
    const tableRows = rows.map((r, i) => ({ "#": i + 1, at: fmtAbsHour(r.absHour), step: r.step }));

    html += `<h3>${hqMarker}${escapeHtml(cName)} (${escapeHtml(cityEco.resource)})${slot ? ` — ${escapeHtml(slot.primaryUnitId.replaceAll("_", " "))}, RO L${slot.roLevel}` : ""}</h3>\n`;
    html += htmlTable(tableRows, ["#", "at", "step"]);
  }
  return html;
}

function renderBuildPlanHtml(analysis: CountryAnalysis): string {
  const { balance, forceProjection } = analysis;

  let html = `<h1>${escapeHtml(balance.countryName)}</h1>\n`;

  if (forceProjection.missingDataDemands.length > 0) {
    html += `<p class="deficit">⚠ MISSING DOCTRINE DATA — excluded from this plan entirely (not planned, not costed):</p>\n`;
    html += `<ul>${forceProjection.missingDataDemands.map(d =>
      `<li class="deficit">${escapeHtml(d.unitId)} × ${d.count} — no mobilisation data for this country's doctrine in the unit catalog</li>`
    ).join("")}</ul>\n`;
  }

  // 1. Resource balance
  html += `<h2>Resource Balance</h2>\n`;
  html += `<p class="label">Manpower is not pooled — checked per-country only.</p>\n`;
  html += htmlBalanceSheet([
    { label: "Eco income (flip-truncated)", values: balance.ecoIncome },
    { label: "+ Starting balance", values: balance.startingBalance },
    { label: "− Eco build cost", values: balance.ecoBuildCost },
    { label: "− Force costs (infra + mob + upkeep)", values: balance.forceCosts },
    { label: "− Garrison upkeep", values: balance.garrisonUpkeep },
    { label: "= Net balance", values: balance.netBalance },
  ], "= Net balance", RESOURCE_KEYS);

  // 2. Research
  html += `<h2>Research</h2>\n`;
  html += `<p class="label">L1 JIT (ends at deadline − mob window); L2+ JIT from deadline.</p>\n`;
  html += renderResearchSection(forceProjection);

  // 3. Combined infrastructure build (eco + mob)
  html += `<h2>Infrastructure Build (eco + military, combined per city)</h2>\n`;
  html += `<p class="label">Eco steps shown only up to each city's flip point (credited toward the military chain, matching what buildCityInfraStepsFromEco actually skips); "→ FLIP" marks the switch to military infra; mob queue follows.</p>\n`;
  html += renderCombinedInfraSection(analysis);

  // 4. Force projection
  html += `<h2>Force Projection</h2>\n`;
  html += `<p class="label">${escapeHtml(forceProjection.demandLabels.join(" · "))}</p>\n`;
  if (forceProjection.infeasible) {
    html += `<p class="deficit">INFEASIBLE${forceProjection.reason ? ` (${escapeHtml(forceProjection.reason)})` : ""}</p>\n`;
  } else {
    html += `<table>${resourceCostHeader()}
      ${resourceCostRow("Infra (RO)", forceProjection.costs.infraRo)}
      ${resourceCostRow("Infra (buildings)", forceProjection.costs.infraBuildings)}
      ${resourceCostRow("Mobilisation", forceProjection.costs.mobilisation)}
      ${resourceCostRow("Upkeep (stepped)", forceProjection.costs.upkeep)}
      ${resourceCostRow("Province mob + mercenary_outpost", forceProjection.costs.provinceMobilisation)}
      ${resourceCostRow("Province upkeep (flat)", forceProjection.costs.provinceUpkeep)}
      ${resourceCostRow("Total", forceProjection.costs.total)}
    </table>\n`;
  }
  if (forceProjection.provinceMobResults.length > 0) {
    html += `<h3>Province Mobilisation Detail</h3>\n`;
    html += `<ul>${forceProjection.provinceMobResults.map(r =>
      `<li>${escapeHtml(r.unitId)} × ${r.count} — mercenary_outpost L${r.mercenaryOutpostRequiredLevel} ` +
      `(${r.mercenaryOutpostBuildHours}h) then mobilise (${r.mobilizationDurationHours}h), ` +
      `completes hour ${r.completionHour}, capacity ${r.provinceCount} provinces</li>`
    ).join("")}</ul>\n`;
  }
  if (forceProjection.skippedDemands.length > 0) {
    html += `<h3>Skipped Demands</h3>\n`;
    html += `<ul>${forceProjection.skippedDemands.map(d => `<li class="skipped">${escapeHtml(d.unitId)} × ${d.count} — launcher platform (zero mob cost)</li>`).join("")}</ul>\n`;
  }

  return html;
}

// ── Main ───────────────────────────────────────────────────────────────────

fs.mkdirSync(path.resolve("tmp"), { recursive: true });

const countryIds = countryFilter === "all" ? Object.keys(plan.countries) : [countryFilter];

const countryBalances: CountryResourceBalance[] = [];
for (const countryId of countryIds) {
  const analysis = analyseCountry(countryId);
  countryBalances.push(analysis.balance);

  const bpHtml = buildHtml(`Build Plan — ${analysis.balance.countryName}`, renderBuildPlanHtml(analysis));
  const bpOutPath = path.resolve(`tmp/bp-${countryId}.html`);
  fs.writeFileSync(bpOutPath, bpHtml, "utf8");
  console.log(`  → wrote ${bpOutPath}`);
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
