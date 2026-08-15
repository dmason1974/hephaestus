// Hand-specified "iron" eco heuristic for OCCUPIED countries — no force projection
// (these countries have no demands in the plan; eco income only, feeding the shared
// coalition pool). Heuristic: RO1 first in every city (unconditional), then only
// electronics cities get further improvement — annex, then arms_industry straight
// to L5. Other-resource cities (fuel/rares/components/supplies) get RO1 only — no
// annex, no arms_industry, base occupied-rate (25%) production only otherwise. Any
// supplies/electronics province gets
// L1 local industry -> L2 local industry -> L1 combat outpost -> L3 local industry
// (same sequence for both resources, unlike the homeland heuristic where they
// differ); zero yield before the country's capture_day (city AND province).
// Cities/provinces credited to a homeland country (Demand.city_credits/
// province_credits) are EXCLUDED from this report entirely — their production is
// transferred to that homeland's own iron-bp-<country>.html instead (see
// occupied-yield.ts's computeOccupiedYield, shared with iron-bp-plan.ts), so
// nothing is double-counted if a coalition-wide aggregate is ever run.
// Run via IRON_COUNTRY=<id> npm run smoke:iron-occupied-plan.
import fs from "node:fs";
import path from "node:path";

import { scenarioStartAbsoluteHour, toAbsoluteHour } from "../../core/time.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCoalitionPlan } from "../../scenarios/io/load-coalition-plan.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { OCCUPIED_PROVINCE_BUILD_ORDER } from "./iron-heuristic.js";
import {
  RESOURCE_KEYS,
  addInto,
  buildingLevelCost,
  computeOccupiedYield,
  provinceCreditKeyFromCohortId,
  zeroResources,
} from "./occupied-yield.js";

const scenarioId = process.env.IRON_SCENARIO ?? "elite/antarctica";
const planId = process.env.IRON_PLAN ?? "pnth-v-iron-2026-aug";
const countryId = process.env.IRON_COUNTRY;
if (!countryId) {
  throw new Error("IRON_COUNTRY is required, e.g. IRON_COUNTRY=norway npm run smoke:iron-occupied-plan");
}

const plan = loadScenarioCoalitionPlan(scenarioId, planId);
const scenario = loadScenarioFile(scenarioId);
const buildings = loadBuildingsFile(path.resolve("data/buildings.yml"));
const country = loadScenarioCountry(scenarioId, countryId);
const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
const deadlineAbsHour = scenarioAbsHour + plan.truce_days * 24;
const hoursToSimulate = plan.truce_days * 24;

const countryPlan = plan.countries[countryId];
const captureDay = countryPlan?.capture_day ?? 4;
const captureAbsHour = toAbsoluteHour(captureDay, 0);
const captureRelHour = captureAbsHour - scenarioAbsHour;

// Plan mechanic: disbanding the starting-garrison gunships (day 4, see CLAUDE.md's
// "Starting Units — Garrison Mechanic") forces destruction of each capital's original
// airport (air_base level 1) the same day. Defaults to day 4; override with
// IRON_AIRPORT_DESTROY_DAY=<day> for what-if variants.
const airportDestroyDay = process.env.IRON_AIRPORT_DESTROY_DAY
  ? Number(process.env.IRON_AIRPORT_DESTROY_DAY)
  : 4;
const forcedAirBaseDestructionAbsHour: Record<string, number> = Object.fromEntries(
  country.cities
    .filter(city => city.capital)
    .map(city => [`${country.country.id}:${city.id}`, toAbsoluteHour(airportDestroyDay + 1, 0)])
);

const {
  segmentsByCity,
  cityYieldByCity,
  hourlyProductionByCity,
  cityEcoBuildCost,
  provinceCohorts,
  provinceYieldByCohort,
  provinceBuildCost,
  provinceCostEvents,
} = computeOccupiedYield({
  country,
  scenario,
  buildings,
  captureDay,
  captureRelHour,
  hoursToSimulate,
  truceDays: plan.truce_days,
  forcedAirBaseDestructionAbsHour,
  cityIdFilter: bareCityId => !countryPlan?.city_credits?.[bareCityId],
  cohortCountOverride: (cohortId, fullCount) => {
    const key = provinceCreditKeyFromCohortId(cohortId);
    const credits = countryPlan?.province_credits?.[key as keyof NonNullable<typeof countryPlan.province_credits>];
    if (!credits) return fullCount;
    const creditedSum = Object.values(credits).reduce((a, b) => a + b, 0);
    return Math.max(0, fullCount - creditedSum);
  },
});

// ── HTML helpers (copied verbatim from iron-eco-plan.ts so output format matches) ──

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
  const body = rows.map(row => `<tr>${headers.map(h => `<td>${escapeHtml(row[h])}</td>`).join("")}</tr>`).join("");
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
  .capital { font-weight: bold; }
  .label { color: #666; font-size: 11px; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

let html = `<h1>${escapeHtml(country.country.name)} — Iron Build Plan</h1>\n`;
html += `<p class="label">Doctrine: ${escapeHtml(country.country.doctrine)} · Status: occupied · Deadline: ${fmtAbsHour(deadlineAbsHour)} (${plan.truce_days} days) · captured day ${captureDay}</p>\n`;
html += `<p class="label">Hand-specified occupied-country build order, not the coalition-weight beam: RO1 first in every city, then electronics cities additionally get annex + arms_industry &rarr; L5. Other-resource cities get RO1 only. No force projection (no demands for occupied countries). Cities/provinces credited to a homeland country are excluded from this report entirely — see that country's own iron-bp-&lt;country&gt;.html.</p>\n`;

const provinceIncome = zeroResources();
for (const pr of provinceYieldByCohort) addInto(provinceIncome, pr.total);

// ── Resource balance (Starting Balance / Mobilisation / Upkeep all zero — occupied,
// no force projection, no garrison) ────────────────────────────────────────

const startingBalance = zeroResources();
const mobilisationCostTotal = zeroResources();
const upkeepCostTotal = zeroResources();

const ecoIncomeTotal = zeroResources();
for (const total of cityYieldByCity.values()) addInto(ecoIncomeTotal, total);
addInto(ecoIncomeTotal, provinceIncome);

const infraCostTotal = zeroResources();
addInto(infraCostTotal, cityEcoBuildCost);
addInto(infraCostTotal, provinceBuildCost);

const netBalance = zeroResources();
for (const r of RESOURCE_KEYS) {
  netBalance[r] = startingBalance[r] + ecoIncomeTotal[r] - infraCostTotal[r] - mobilisationCostTotal[r] - upkeepCostTotal[r];
}

function balanceRow(label: string, values: Record<Resource, number>, bold = false): string {
  const cells = RESOURCE_KEYS.map(r => `<td>${fmt(Math.round(values[r]))}</td>`).join("");
  return bold ? `<tr><td><strong>${escapeHtml(label)}</strong></td>${cells}</tr>` : `<tr><td>${escapeHtml(label)}</td>${cells}</tr>`;
}

html += `\n<h2>Resource Balance</h2>\n`;
html += `<p class="label">Manpower is not pooled — checked per-country only. Starting Balance/Mobilisation/Upkeep are all zero (occupied country, no force projection, no garrison).</p>\n`;
html += `<table><thead><tr><th></th>${RESOURCE_KEYS.map(r => `<th>${r}</th>`).join("")}</tr></thead><tbody>`;
html += balanceRow("Starting Balance", startingBalance, true);
html += balanceRow("Eco Income", ecoIncomeTotal, true);
html += balanceRow("Infra Costs", infraCostTotal, true);
html += balanceRow("Mobilisation Costs", mobilisationCostTotal, true);
html += balanceRow("Upkeep Costs", upkeepCostTotal, true);
html += `<tr><td><strong>= Net Balance</strong></td>${RESOURCE_KEYS.map(r => {
  const v = Math.round(netBalance[r]);
  const color = v < 0 ? "#cf222e" : "#1a7f37";
  return `<td style="color:${color};font-weight:600">${fmt(v)}</td>`;
}).join("")}</tr>`;
html += `</tbody></table>\n`;

// ── Resource Minima (hourly cash-flow walk) — city costs only, same scope-limit as
// the homeland iron scripts (province build costs aren't included there either) ──

type CostEvent = { hour: number; cost: Partial<Record<Resource, number>> };
const costEvents: CostEvent[] = [...provinceCostEvents];
for (const city of country.cities) {
  const prefixedId = `${country.country.id}:${city.id}`;
  const segs = segmentsByCity.get(prefixedId);
  for (const s of [...(segs?.annex_city ?? []), ...(segs?.arms_industry ?? [])]) {
    costEvents.push({ hour: s.startMinute / 60, cost: buildingLevelCost(buildings, s.buildingId, s.toLevel) });
  }
}
costEvents.sort((a, b) => a.hour - b.hour);

function incomeAtHour(absHour: number): Record<Resource, number> {
  const total = zeroResources();
  const relHour = absHour - scenarioAbsHour;
  for (const city of country.cities) {
    const hourly = hourlyProductionByCity.get(`${country.country.id}:${city.id}`) ?? [];
    const prod = hourly[relHour] ?? {};
    for (const r of RESOURCE_KEYS) total[r] += prod[r] ?? 0;
  }
  if (relHour >= captureRelHour) {
    // provinceIncome is already capture-zeroed (only accrues over
    // [captureRelHour, hoursToSimulate)), so the flat rate must divide by that
    // same post-capture window length, not the full hoursToSimulate — otherwise
    // the walk under-distributes it (confirmed via a diagnostic probe on Norway).
    const postCaptureHours = Math.max(1, hoursToSimulate - captureRelHour);
    for (const r of RESOURCE_KEYS) total[r] += provinceIncome[r] / postCaptureHours;
  }
  return total;
}

const running = zeroResources();
const minima = {} as Record<Resource, { value: number; hour: number }>;
for (const r of RESOURCE_KEYS) minima[r] = { value: 0, hour: scenarioAbsHour };
const firstNegative = {} as Record<Resource, { value: number; hour: number } | undefined>;
for (const r of RESOURCE_KEYS) firstNegative[r] = undefined;

// hourlyNetFlow (index 0 = scenarioAbsHour) is exported alongside the rendered
// minima table so a coalition aggregate can pool real per-hour deltas across
// countries — summing each country's own minima value is not a true pooled minimum.
const hourlyNetFlow: Array<Record<Resource, number>> = [];

const DEBUG_totalIncomeWalked = zeroResources();
const DEBUG_totalCostWalked = zeroResources();

let eventIdx = 0;
for (let h = scenarioAbsHour; h < deadlineAbsHour; h++) {
  const inc = incomeAtHour(h);
  const flow = zeroResources();
  for (const r of RESOURCE_KEYS) { flow[r] = inc[r]; DEBUG_totalIncomeWalked[r] += inc[r]; }
  while (eventIdx < costEvents.length && Math.floor(costEvents[eventIdx].hour) <= h) {
    for (const r of RESOURCE_KEYS) { flow[r] -= costEvents[eventIdx].cost[r] ?? 0; DEBUG_totalCostWalked[r] += costEvents[eventIdx].cost[r] ?? 0; }
    eventIdx++;
  }
  for (const r of RESOURCE_KEYS) running[r] += flow[r];
  hourlyNetFlow.push(flow);
  for (const r of RESOURCE_KEYS) {
    if (running[r] < minima[r].value) minima[r] = { value: running[r], hour: h };
    if (firstNegative[r] === undefined && running[r] < 0) firstNegative[r] = { value: running[r], hour: h };
  }
}
if (process.env.IRON_DEBUG_RECONCILE) {
  for (const r of RESOURCE_KEYS) {
    console.error(
      `[DEBUG ${countryId}] ${r}: walked_income=${Math.round(DEBUG_totalIncomeWalked[r])} ` +
      `ecoIncomeTotal=${Math.round(ecoIncomeTotal[r])} income_gap=${Math.round(DEBUG_totalIncomeWalked[r] - ecoIncomeTotal[r])} ` +
      `walked_cost=${Math.round(DEBUG_totalCostWalked[r])} infraCostTotal=${Math.round(infraCostTotal[r])} cost_gap=${Math.round(DEBUG_totalCostWalked[r] - infraCostTotal[r])}`
    );
  }
}

html += `\n<h2>Resource Minima (hourly cash-flow walk)</h2>\n`;
html += `<p class="label">Country-level (manpower included). Province build costs are not included in this walk (same scope as the homeland iron scripts) — a shortfall detector, not a bit-exact reconciliation of the totals above.</p>\n`;
html += renderTable(
  RESOURCE_KEYS.map(r => ({
    resource: r,
    "first-neg hour": firstNegative[r] ? fmtAbsHour(firstNegative[r]!.hour) : "—",
    "first-neg value": firstNegative[r] ? fmt(Math.round(firstNegative[r]!.value)) : "—",
    "minima hour": fmtAbsHour(minima[r].hour),
    "minima value": fmt(Math.round(minima[r].value)),
  })),
  ["resource", "first-neg hour", "first-neg value", "minima hour", "minima value"],
);

// ── City Build Plans (display) ─────────────────────────────────────────────

html += `\n<h2>City Build Plans</h2>\n`;
const cityRows: string[] = [];
cityRows.push(`<tr><th>City</th><th>Resource</th><th>Build Sequence</th><th>Last build completes</th></tr>`);
for (const city of country.cities) {
  const cityId = `${country.country.id}:${city.id}`;
  const creditedTo = countryPlan?.city_credits?.[city.id];
  const segs = segmentsByCity.get(cityId);
  const allSegs = [...(segs?.annex_city ?? []), ...(segs?.arms_industry ?? [])].sort((a, b) => a.startMinute - b.startMinute);
  const seqLines = creditedTo
    ? `→ credited to ${creditedTo}`
    : allSegs.length === 0
    ? "(no builds)"
    : allSegs.map(s => `L${s.toLevel} ${s.buildingId.replaceAll("_", " ")} @ ${fmtAbsHour(s.startMinute / 60)}`).join("\n");
  const lastCompletionMinute = allSegs.length === 0 ? undefined : Math.max(...allSegs.map(s => s.endMinute));
  const lastBuildStr = creditedTo ? "—" : lastCompletionMinute === undefined ? "—" : fmtAbsHour(lastCompletionMinute / 60);
  const isCapital = city.capital;
  const cityLabel = isCapital ? `★ ${city.name}` : city.name;
  cityRows.push(`<tr>
    <td class="${isCapital ? "capital" : ""}">${escapeHtml(cityLabel)}</td>
    <td>${escapeHtml(city.resource)}</td>
    <td style="white-space:pre-wrap">${escapeHtml(seqLines)}</td>
    <td>${escapeHtml(lastBuildStr)}</td>
  </tr>`);
}
html += `<table>${cityRows.join("")}</table>`;

// ── Province Build Plans (display) ─────────────────────────────────────────

html += `\n<h2>Province Build Plans</h2>\n`;
html += `<p class="label">supplies/electronics cohorts get the occupied-country heuristic's build sequence; every other cohort gets no build (base occupied-rate production only).</p>\n`;
const provRows: string[] = [];
provRows.push(`<tr><th>Cohort</th><th>Resource</th><th>Provinces</th><th>Build Sequence</th></tr>`);
for (const cohort of provinceCohorts) {
  const creditKey = provinceCreditKeyFromCohortId(cohort.cohortId);
  const credits = countryPlan?.province_credits?.[creditKey as keyof NonNullable<typeof countryPlan.province_credits>];
  const steps = (cohort.resource && OCCUPIED_PROVINCE_BUILD_ORDER[cohort.resource]) ?? [];
  const seqLabel = credits
    ? `→ credited: ${Object.entries(credits).map(([c, n]) => `${n} to ${c}`).join(", ")}`
    : steps.length === 0
    ? "(no builds)"
    : steps.map(s => `L${s.targetLevel} ${s.buildingId.replaceAll("_", " ")}`).join(" → ");
  const cohortLabel = cohort.cohortId.split(":")[1] ?? cohort.cohortId;
  provRows.push(`<tr>
    <td>${escapeHtml(cohortLabel)}</td>
    <td>${escapeHtml(cohort.resource ?? "—")}</td>
    <td style="text-align:center">${cohort.totalProvinceCount}</td>
    <td>${escapeHtml(seqLabel)}</td>
  </tr>`);
}
html += `<table>${provRows.join("")}</table>`;

// ── Force Projection placeholder (none — eco only) ─────────────────────────

html += `\n<h2>Force Projection</h2>\n`;
html += `<p class="label">(none — occupied, eco only)</p>\n`;

// Machine-readable hourly net flow — same embed convention as iron-bp-plan.ts, so
// the coalition aggregate can pool occupied countries into the true hour-aligned
// walk too (they still draw from / contribute to the shared pool).
html += `<script type="application/json" id="iron-hourly-net-flow" data-scenario-abs-hour="${scenarioAbsHour}" data-resource-order="${RESOURCE_KEYS.join(",")}">${JSON.stringify(
  hourlyNetFlow.map(flow => RESOURCE_KEYS.map(r => Math.round(flow[r])))
)}</script>\n`;

fs.mkdirSync(path.resolve("tmp"), { recursive: true });
const outHtml = buildHtml(`Iron Build Plan — ${country.country.name}`, html);
const outPath = path.resolve(`tmp/iron-bp-${countryId}.html`);
fs.writeFileSync(outPath, outHtml, "utf8");
console.log(`→ wrote ${outPath}`);

// ── iron-eco-<country>.html — same shape as the homeland iron-eco-plan.ts output,
// so occupied countries get the identical 3-file debugging set (eco/fp/bp; "fp" is
// skipped here since there's no force projection to run). Reuses everything already
// computed above (segmentsByCity, cityYieldByCity, provinceCohorts,
// provinceYieldByCohort) — no recomputation. ─────────────────────────────────────

let ecoHtml = `<h1>${escapeHtml(country.country.name)} — Iron Eco Heuristic (Occupied)</h1>\n`;
ecoHtml += `<p class="label">Doctrine: ${escapeHtml(country.country.doctrine)} · Status: occupied · Truce: ${plan.truce_days} days · captured day ${captureDay}</p>\n`;
ecoHtml += `<p class="label">Hand-specified build order, not the coalition-weight beam: only electronics cities are in scope for any improvement — annex first, then arms_industry &rarr; L5. Other-resource cities get no improvements at all. Zero yield before capture day (city and province).</p>\n`;

ecoHtml += `\n<h2>City Eco Build Plans</h2>\n`;
const ecoCityRows: string[] = [];
ecoCityRows.push(`<tr><th>City</th><th>Resource</th><th>Eco Build Sequence</th><th>Last build completes</th><th>Explored</th></tr>`);
for (const city of country.cities) {
  const cityId = `${country.country.id}:${city.id}`;
  const segs = segmentsByCity.get(cityId);
  const allSegs = [...(segs?.annex_city ?? []), ...(segs?.arms_industry ?? [])].sort((a, b) => a.startMinute - b.startMinute);
  const seqLines = allSegs.length === 0
    ? "(no builds)"
    : allSegs.map(s => `L${s.toLevel} ${s.buildingId.replaceAll("_", " ")} @ ${fmtAbsHour(s.startMinute / 60)}`).join("\n");
  const lastCompletionMinute = allSegs.length === 0 ? undefined : Math.max(...allSegs.map(s => s.endMinute));
  const lastBuildStr = lastCompletionMinute === undefined ? "—" : fmtAbsHour(lastCompletionMinute / 60);
  const isCapital = city.capital;
  const cityLabel = isCapital ? `★ ${city.name}` : city.name;
  ecoCityRows.push(`<tr>
    <td class="${isCapital ? "capital" : ""}">${escapeHtml(cityLabel)}</td>
    <td>${escapeHtml(city.resource)}</td>
    <td style="white-space:pre-wrap">${escapeHtml(seqLines)}</td>
    <td>${escapeHtml(lastBuildStr)}</td>
    <td>manual</td>
  </tr>`);
}
ecoHtml += `<table>${ecoCityRows.join("")}</table>`;

ecoHtml += `\n<h2>Province Eco Build Plans</h2>\n`;
ecoHtml += `<p class="label">supplies/electronics cohorts get the occupied-country heuristic's build sequence; every other cohort gets no build (base occupied-rate production only).</p>\n`;
const ecoProvRows: string[] = [];
ecoProvRows.push(`<tr><th>Cohort</th><th>Resource</th><th>Provinces</th><th>Eco Build Sequence</th></tr>`);
for (const cohort of provinceCohorts) {
  const steps = (cohort.resource && OCCUPIED_PROVINCE_BUILD_ORDER[cohort.resource]) ?? [];
  const seqLabel = steps.length === 0
    ? "(no builds)"
    : steps.map(s => `L${s.targetLevel} ${s.buildingId.replaceAll("_", " ")}`).join(" → ");
  const cohortLabel = cohort.cohortId.split(":")[1] ?? cohort.cohortId;
  ecoProvRows.push(`<tr>
    <td>${escapeHtml(cohortLabel)}</td>
    <td>${escapeHtml(cohort.resource ?? "—")}</td>
    <td style="text-align:center">${cohort.totalProvinceCount}</td>
    <td>${escapeHtml(seqLabel)}</td>
  </tr>`);
}
ecoHtml += `<table>${ecoProvRows.join("")}</table>`;

ecoHtml += `\n<h2>City Production Summary (full ${plan.truce_days}-day eco window)</h2>\n`;
ecoHtml += `<p class="label">Total resource flow over the full truce window under the occupied-country iron heuristic (gross production, zero before capture day; does not net out build costs). Manpower is not pooled.</p>\n`;
const summaryRows: string[] = [];
summaryRows.push(`<tr><th>City</th><th>Resource</th>${RESOURCE_KEYS.map(r => `<th>${r}</th>`).join("")}</tr>`);
const countryTotal = zeroResources();
for (const city of country.cities) {
  const cityTotal = cityYieldByCity.get(`${country.country.id}:${city.id}`) ?? zeroResources();
  addInto(countryTotal, cityTotal);
  const isCapital = city.capital;
  const cityLabel = isCapital ? `★ ${city.name}` : city.name;
  summaryRows.push(`<tr>
    <td class="${isCapital ? "capital" : ""}">${escapeHtml(cityLabel)}</td>
    <td>${escapeHtml(city.resource)}</td>
    ${RESOURCE_KEYS.map(r => `<td>${fmt(Math.round(cityTotal[r]))}</td>`).join("")}
  </tr>`);
}
for (const pr of provinceYieldByCohort) {
  addInto(countryTotal, pr.total);
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
ecoHtml += `<table>${summaryRows.join("")}</table>`;

const ecoOutHtml = buildHtml(`Iron Eco Plan — ${country.country.name}`, ecoHtml);
const ecoOutPath = path.resolve(`tmp/iron-eco-${countryId}.html`);
fs.writeFileSync(ecoOutPath, ecoOutHtml, "utf8");
console.log(`→ wrote ${ecoOutPath}`);
