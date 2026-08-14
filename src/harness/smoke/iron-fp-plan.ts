// "Iron" force projection — reuses the existing, trusted Unit 2 engine
// (computeCountryForceProjection) exactly as-is, no engine changes. This is
// the RO-level/city-count optimizer the user has confirmed already works; the goal
// here is just to see where it lands for a country's real PNTH V Iron demands, run
// standalone (no eco-credit linkage to the iron-eco-<country>.html build — decoupled
// for this pass, i.e. planWeights/actualEcoResultsByCity both omitted, same as the
// existing force-projection.ts harness already does for every country it runs).
// Run via IRON_COUNTRY=<id> npm run smoke:iron-fp-plan.
import fs from "node:fs";
import path from "node:path";

import type { Resource } from "../../core/constants.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import { computeCountryForceProjection } from "../../engine/optimization/country-force-projection.js";
import type { ResourceCost } from "../../engine/optimization/types.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCoalitionPlan } from "../../scenarios/io/load-coalition-plan.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadMergedUnitCatalogForScenario } from "../../scenarios/io/load-unit-catalog.js";

const scenarioId = process.env.IRON_SCENARIO ?? "elite/antarctica";
const planId = process.env.IRON_PLAN ?? "pnth-v-iron-2026-aug";
const countryId = process.env.IRON_COUNTRY;
if (!countryId) {
  throw new Error("IRON_COUNTRY is required, e.g. IRON_COUNTRY=south_africa npm run smoke:iron-fp-plan");
}
const maxRoLevel = 5;

const plan = loadScenarioCoalitionPlan(scenarioId, planId);
const scenario = loadScenarioFile(scenarioId);
const buildings = loadBuildingsFile(path.resolve("data/buildings.yml"));
const catalog = loadMergedUnitCatalogForScenario(scenarioId);
const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
const deadlineAbsHour = scenarioAbsHour + plan.truce_days * 24;

const RESOURCE_KEYS: Resource[] = ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"];

// ── HTML helpers (copied verbatim from force-projection.ts) ───────────────────

function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtAbsHour(h: number): string {
  const day = Math.floor(h / 24) + 1;
  const hour = Math.floor(h % 24);
  return `day ${day} h${String(hour).padStart(2, "0")}`;
}

function renderTable(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0) return "<p><em>None</em></p>\n";
  const headers = columns ?? Object.keys(rows[0]);
  const head = `<tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
  const body = rows
    .map(row => `<tr>${headers.map(h => `<td>${escapeHtml(row[h])}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>\n`;
}

function resourceTableHeader(): string {
  return `<tr><th></th>${RESOURCE_KEYS.map(r => `<th>${r}</th>`).join("")}</tr>`;
}

function resourceRow(label: string, cost: ResourceCost): string {
  return `<tr><td>${escapeHtml(label)}</td>${RESOURCE_KEYS.map(r => {
    const v = Math.round(cost[r] ?? 0);
    return `<td>${v !== 0 ? fmt(v) : "—"}</td>`;
  }).join("")}</tr>`;
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
  h3 { font-size: 0.95rem; margin: 1rem 0 0.3rem; color: #333; }
  table { border-collapse: collapse; margin-bottom: 0.8rem; }
  th, td { border: 1px solid #ccc; padding: 3px 8px; text-align: right; white-space: nowrap; }
  th { background: #f0f0f0; text-align: center; font-size: 11px; }
  td:first-child, th:first-child { text-align: left; }
  .label { color: #666; font-size: 11px; }
  .infeasible { color: #cf222e; font-weight: bold; }
  .skipped { color: #888; font-style: italic; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

// ── Analysis ────────────────────────────────────────────────────────────────

const country = loadScenarioCountry(scenarioId, countryId);
const doctrine = country.country.doctrine;
const countryPlan = plan.countries[countryId];
const status = countryPlan?.status ?? "homeland";

const result = computeCountryForceProjection({
  country,
  doctrine,
  status,
  demands: countryPlan?.demands ?? [],
  scenario,
  buildings,
  catalog,
  scenarioAbsHour,
  deadlineAbsHour,
  truceDays: plan.truce_days,
  maxRoLevel,
});

let html = `<h1>${escapeHtml(result.countryName)} — Iron Force Projection</h1>\n`;
html += `<p class="label">Doctrine: ${escapeHtml(doctrine)} · Status: ${escapeHtml(status)} `;
html += `· Deadline: ${fmtAbsHour(deadlineAbsHour)} (${plan.truce_days} days) · morale ${result.moraleAtStart}%&rarr;${result.moraleAtDeadline}%</p>\n`;
html += `<p class="label">Runs the existing Unit 2 force-projection engine unmodified (computeCountryForceProjection) — city count and RO level per demand are exactly what that function decides. Not eco-credited (planWeights/actualEcoResultsByCity omitted): infra chains build from scratch, decoupled from iron-eco-italy.html for this pass.</p>\n`;

if (result.reason === "no_demands") {
  html += `<p class="skipped">No demands defined for ${countryId}.</p>`;
} else if (result.reason === "no_active_demands") {
  html += `<p class="skipped">No city-mobilised demands for ${countryId}.</p>`;
} else {
  const cityNameMap = new Map<string, string>(country.cities.map(c => [c.id, c.name]));

  html += `<h2>Research Plan</h2>\n`;
  html += `<p class="label">L1 JIT (ends at deadline − mob window); L2+ JIT from deadline. Priority: impact × demand count.</p>\n`;
  const researchRows = result.researchSegments
    .slice()
    .sort((a, b) => a.slot - b.slot || a.startAbsoluteHour - b.startAbsoluteHour)
    .map(s => ({
      slot: `Slot ${s.slot}`,
      unit: s.unitId.replaceAll("_", " "),
      level: s.level,
      start: fmtAbsHour(s.startAbsoluteHour),
      complete: fmtAbsHour(s.endAbsoluteHourExclusive),
      duration: `${s.durationHours}h`,
    }));
  html += renderTable(researchRows, ["slot", "unit", "level", "start", "complete", "duration"]);

  html += `<h2>City Mob Build Plans</h2>\n`;
  html += `<p class="label">One section per city. Mob queue ordered ascending by total burden (upkeepRate × count) — lowest-burden batches mob first, highest-burden mobs last (JIT). `;
  html += `Infra built JIT for primary (heaviest) unit; compatible lighter units absorb into same city. RO L1 built first to start manpower income.</p>\n`;

  if (result.citySlots.length === 0) {
    html += `<p class="infeasible">INFEASIBLE — fold-in found no feasible city allocation.</p>\n`;
  }

  for (const slot of result.citySlots) {
    const cName = cityNameMap.get(slot.cityId) ?? slot.cityId;
    const queueSummary = slot.mobQueue.map(e => `${e.unitId.replaceAll("_", " ")} ×${e.count}`).join(", ");
    html += `<h3>${escapeHtml(cName)} — RO L${slot.roLevel}</h3>\n`;
    html += `<p class="label">Infra: ${escapeHtml(slot.primaryUnitId.replaceAll("_", " "))} requirements · Mob queue: ${escapeHtml(queueSummary)}</p>\n`;
    html += `<p class="label"><strong>Flip point: ${fmtAbsHour(slot.flipPointAbsHour)}</strong> — eco until then, military infra after.</p>\n`;

    const stepRows: Array<Record<string, unknown>> = slot.infraSteps.map((s, i) => ({
      "#": i + 1,
      step: s.name,
      start: fmtAbsHour(s.startHour),
      complete: fmtAbsHour(s.endHour),
      dur: `${s.durH}h`,
    }));

    let stepNum = slot.infraSteps.length + 1;
    for (const entry of slot.mobSteps) {
      stepRows.push({
        "#": stepNum++,
        step: `${entry.unitId.replaceAll("_", " ")} mob ×${entry.count}`,
        start: fmtAbsHour(entry.startAbsHour),
        complete: fmtAbsHour(entry.endAbsHour),
        dur: `${Math.round(entry.durationHours)}h`,
      });
    }
    html += renderTable(stepRows, ["#", "step", "start", "complete", "dur"]);
  }

  html += `<h2>Mobilisation Cost Summary</h2>\n`;
  html += `<p class="label">${escapeHtml(result.demandLabels.join(" · "))}</p>\n`;

  if (result.infeasible) {
    html += `<p class="infeasible">INFEASIBLE — no cities allocated.</p>\n`;
  } else {
    html += `<table>
      ${resourceTableHeader()}
      ${resourceRow("Infra (RO)", result.costs.infraRo)}
      ${resourceRow("Infra (buildings)", result.costs.infraBuildings)}
      ${resourceRow("Mobilisation", result.costs.mobilisation)}
      ${resourceRow("Upkeep (stepped)", result.costs.upkeep)}
      ${resourceRow("Province mob + mercenary_outpost", result.costs.provinceMobilisation)}
      ${resourceRow("Province upkeep (flat)", result.costs.provinceUpkeep)}
      ${resourceRow("Total", result.costs.total)}
    </table>\n`;
  }

  if (result.provinceMobResults.length > 0) {
    html += `<h2>Province Mobilisation Detail</h2>\n`;
    html += `<ul>${result.provinceMobResults
      .map(
        r =>
          `<li>${escapeHtml(r.unitId)} × ${r.count} — mercenary_outpost L${r.mercenaryOutpostRequiredLevel} ` +
          `(${r.mercenaryOutpostBuildHours}h) then mobilise (${r.mobilizationDurationHours}h), ` +
          `completes hour ${r.completionHour}, capacity ${r.provinceCount} provinces</li>`
      )
      .join("")}</ul>\n`;
  }

  const skipped = [...result.skippedDemands.map(d => `${d.unitId} × ${d.count} — launcher platform (zero mob cost)`)];
  if (result.missingDataDemands.length > 0) {
    html += `<h2>&#9888; Missing Doctrine Data</h2>\n`;
    html += `<ul>${result.missingDataDemands
      .map(d => `<li class="infeasible">${escapeHtml(d.unitId)} × ${d.count} — no ${escapeHtml(doctrine)} mobilisation data</li>`)
      .join("")}</ul>\n`;
  }
  if (skipped.length > 0) {
    html += `<h2>Skipped Demands</h2>\n`;
    html += `<ul>${skipped.map(s => `<li class="skipped">${escapeHtml(s)}</li>`).join("")}</ul>\n`;
  }
}

fs.mkdirSync(path.resolve("tmp"), { recursive: true });
const outHtml = buildHtml(`Iron Force Projection — ${country.country.name}`, html);
const outPath = path.resolve(`tmp/iron-fp-${countryId}.html`);
fs.writeFileSync(outPath, outHtml, "utf8");
console.log(`→ wrote ${outPath}`);
