/**
 * @deprecated Superseded by `smoke:resource-projection`'s `bp-<country>.html` output,
 * whose Research + combined Infrastructure Build sections cover the same ground as
 * this harness's Research Plan + City Mob Build Plans sections — and do it better,
 * since they're eco-credited (Unit 1.5's runActualEcoBuild), which this Unit-2-only
 * harness never is. Kept for now as a standalone Unit 2 view; not actively maintained.
 */
import fs from "node:fs";
import path from "node:path";

import type { Resource } from "../../core/constants.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import type { ResourceCost } from "../../engine/optimization/types.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioCoalitionPlan } from "../../scenarios/io/load-coalition-plan.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadMergedUnitCatalogForScenario } from "../../scenarios/io/load-unit-catalog.js";
import { computeCountryForceProjection } from "../../engine/optimization/country-force-projection.js";

// ── Config ─────────────────────────────────────────────────────────────────

const scenarioId = process.env.FP_SCENARIO ?? "elite/antarctica";
const planId = process.env.FP_PLAN ?? "pnth_v_road_2026_jun";
const countryFilter = process.env.FP_COUNTRY ?? "all";
const maxRoLevel = parsePositiveInt(process.env.FP_MAX_RO, 5);

function parsePositiveInt(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── Data loading ───────────────────────────────────────────────────────────

const plan = loadScenarioCoalitionPlan(scenarioId, planId);
const scenario = loadScenarioFile(scenarioId);
const buildings = loadBuildingsFile(path.resolve("data/buildings.yml"));
const catalog = loadMergedUnitCatalogForScenario(scenarioId);
const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
const deadlineAbsHour = scenarioAbsHour + plan.truce_days * 24;

const RESOURCE_KEYS: Resource[] = [
  "supplies", "components", "fuel", "rares", "electronics", "cash", "manpower",
];

// ── HTML helpers ───────────────────────────────────────────────────────────

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

// ── Per-country analysis ───────────────────────────────────────────────────

function analyseCountry(countryId: string): string {
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
    researchBufferHours: plan.research_buffer_hours,
    researchAsapPins: countryPlan?.research_asap_pins,
  });

  if (result.reason === "no_demands") {
    return `<p class="skipped">No demands defined for ${countryId}.</p>`;
  }
  if (result.reason === "no_active_demands") {
    return `<p class="skipped">No city-mobilised demands for ${countryId}.</p>`;
  }

  const cityNameMap = new Map<string, string>(country.cities.map(c => [c.id, c.name]));

  let html = `<h1>${escapeHtml(result.countryName)}</h1>\n`;
  html += `<p class="label">Doctrine: ${escapeHtml(doctrine)} · Status: ${escapeHtml(status)} `;
  html += `· Deadline: ${fmtAbsHour(deadlineAbsHour)} (${plan.truce_days} days) · morale ${result.moraleAtStart}%→${result.moraleAtDeadline}%</p>\n`;

  // Section 1: Combined JIT research plan
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

  // Section 2: City Mob Build Plans (fold-in result — city-centric view)
  html += `<h2>City Mob Build Plans</h2>\n`;
  html += `<p class="label">One section per city. Mob queue ordered ascending by total burden (upkeepRate × count) — lowest-burden batches mob first, highest-burden mobs last (JIT). `;
  html += `Infra built JIT for primary (heaviest) unit; compatible lighter units absorb into same city. RO L1 built first to start manpower income.</p>\n`;

  if (result.citySlots.length === 0) {
    html += `<p class="infeasible">INFEASIBLE — fold-in found no feasible city allocation.</p>\n`;
  }

  for (const slot of result.citySlots) {
    const cName = cityNameMap.get(slot.cityId) ?? slot.cityId;
    const queueSummary = slot.mobQueue.map(e =>
      `${e.unitId.replaceAll("_", " ")} ×${e.count}`
    ).join(", ");
    html += `<h3>${escapeHtml(cName)} — RO L${slot.roLevel}</h3>\n`;
    html += `<p class="label">Infra: ${escapeHtml(slot.primaryUnitId.replaceAll("_", " "))} requirements · Mob queue: ${escapeHtml(queueSummary)}</p>\n`;

    html += `<p class="label"><strong>Flip point: ${fmtAbsHour(slot.flipPointAbsHour)}</strong> — eco until then, military infra after.</p>\n`;

    const stepRows: Array<Record<string, unknown>> = slot.infraSteps.map((s, i) => ({
      "#": i + 1, step: s.name,
      start: fmtAbsHour(s.startHour), complete: fmtAbsHour(s.endHour), dur: `${s.durH}h`,
    }));

    let stepNum = slot.infraSteps.length + 1;
    for (const entry of slot.mobSteps) {
      stepRows.push({
        "#": stepNum++,
        step: `${entry.unitId.replaceAll("_", " ")}${entry.level ? ` L${entry.level}` : ""} mob ×${entry.count}`,
        start: fmtAbsHour(entry.startAbsHour),
        complete: fmtAbsHour(entry.endAbsHour),
        dur: `${Math.round(entry.durationHours)}h`,
      });
    }
    html += renderTable(stepRows, ["#", "step", "start", "complete", "dur"]);
  }

  // Section 3: Mobilisation Cost Summary — aggregate across all demands
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
    html += `<ul>${result.provinceMobResults.map(r =>
      `<li>${escapeHtml(r.unitId)} × ${r.count} — mercenary_outpost → L${r.mercenaryOutpostRequiredLevel} ` +
      `(${r.mercenaryOutpostBuildHours}h cumulative), capacity ${r.provinceCount} provinces` +
      `<ul>${r.tranches.map(t =>
        `<li>L${t.level}: ${t.count} units — research floor hour ${t.mobilisationEarliestHour}, ` +
        `mobilise ${t.mobStartHour}→${t.completionHour} (${t.mobilizationDurationHours}h)</li>`
      ).join("")}</ul></li>`
    ).join("")}</ul>\n`;
  }

  // Section 5: Skipped demands
  const skipped = [
    ...result.skippedDemands.map(d => `${d.unitId} × ${d.count} — launcher platform (zero mob cost)`),
  ];
  if (skipped.length > 0) {
    html += `<h2>Skipped Demands</h2>\n`;
    html += `<ul>${skipped.map(s => `<li class="skipped">${escapeHtml(s)}</li>`).join("")}</ul>\n`;
  }

  return html;
}

// ── Main ───────────────────────────────────────────────────────────────────

console.warn("[force-projection] deprecated — see `npm run smoke:resource-projection`'s bp-<country>.html output for the eco-credited successor to this harness's Research + City Mob Build Plans sections.");

fs.mkdirSync(path.resolve("tmp"), { recursive: true });

const countryIds =
  countryFilter === "all" ? Object.keys(plan.countries) : [countryFilter];

for (const countryId of countryIds) {
  console.log(`[${countryId}] analysing...`);
  const country = loadScenarioCountry(scenarioId, countryId);
  const body = analyseCountry(countryId);
  const title = `Force Projection — ${country.country.name}`;
  const html = buildHtml(title, body);
  const outPath = path.resolve(`tmp/fp-${countryId}.html`);
  fs.writeFileSync(outPath, html, "utf8");
  console.log(`  → wrote ${outPath}`);
}
