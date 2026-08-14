// Integration step: combines the iron eco build (iron-eco-italy.html, untouched)
// with the existing, trusted Unit 2 force-projection engine (iron-fp-italy.html)
// into one "build plan" HTML, matching bp-italy.html's format. Manual integration
// rules (per user direction, not derived by any engine change):
//   - RO2 (wherever the force projection specified it) is backfilled to the
//     earliest point the eco phase's build queue is actually free — day 2 h01 for
//     components/fuel cities (AI1-only eco build), day 9 h05 for the rest (AI5 eco
//     build) — instead of the force projection's original (late, post-flip) timing.
//   - arms_industry from the force projection's infra chain is dropped entirely —
//     already covered by the eco build (and a no-op either way, since
//     scheduleBuildSegments skips any action whose targetLevel <= currentLevel).
//   - Every other infra step (army_base etc.) carries over unaltered — same
//     target levels, same durations as the force projection computed — just
//     repositioned immediately after the RO2 backfill instead of after the old
//     late RO2+AI sequence.
//   - Mob queue timing is NOT shifted — it stays exactly where the force
//     projection's JIT (deadline-anchored) calculation put it. Backfill finishing
//     early just means more idle time before flip, not an earlier flip — same
//     pattern bp-italy.html's real eco-backfill mechanism already uses.
// Resource Balance section (added): computed directly from this integrated build
// plan — eco income flip-truncated per city at each city's own (unchanged) flip
// point, using the same through-flip-then-flat formula as city-eco-income.ts's
// cityIncomeThroughFlip (reimplemented inline since there's no real CityEcoResult
// object here, just raw simulation output); province income full-window
// (unaffected by city flip); eco build cost = iron-eco's RO1+AI cost + the RO2
// backfill's cost (bucketed as eco spend, matching bp-italy.html's own
// eco-backfill-costs-as-eco-spend convention) + province build cost; force costs =
// army_base cost (the only step left in the force-projection's own infra bucket)
// + mobilisation + upkeep + province mob/upkeep (all unchanged, since none of
// those depend on infra timing); garrison upkeep via the existing, unmodified
// computeGarrisonUpkeep (day-4 disband, matching resource-projection.ts's default).
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
  computeCountryForceProjection,
  computeSteppedUpkeep,
  getLevelSteps,
  type InfraStep,
} from "../../engine/optimization/country-force-projection.js";
import { calculateMobilizationCost } from "../../engine/optimization/cost-calculator.js";
import { computeGarrisonUpkeep } from "../../engine/optimization/garrison-upkeep.js";
import type { ResourceCost } from "../../engine/optimization/types.js";
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
import { loadScenarioCoalitionPlan } from "../../scenarios/io/load-coalition-plan.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadMergedUnitCatalogForScenario } from "../../scenarios/io/load-unit-catalog.js";

const scenarioId = "elite/antarctica";
const planId = "pnth-v-iron-2026-aug";
const countryId = "italy";
const maxRoLevel = 5;

const plan = loadScenarioCoalitionPlan(scenarioId, planId);
const scenario = loadScenarioFile(scenarioId);
const buildings = loadBuildingsFile(path.resolve("data/buildings.yml"));
const catalog = loadMergedUnitCatalogForScenario(scenarioId);
const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
const deadlineAbsHour = scenarioAbsHour + plan.truce_days * 24;
const country = loadScenarioCountry(scenarioId, countryId);

const RESOURCE_KEYS: Resource[] = ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"];

// ── HTML helpers ────────────────────────────────────────────────────────────

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
  h4 { font-size: 0.85rem; margin: 0.6rem 0 0.2rem; color: #555; }
  .pair { display: flex; gap: 1.5rem; align-items: flex-start; flex-wrap: wrap; }
  .pair > div { flex: 0 0 auto; }
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

// ── Eco phase (identical to iron-eco-plan.ts — untouched) ─────────────────────

const AI_TARGET_BY_RESOURCE: Record<string, number> = {
  supplies: 5,
  electronics: 5,
  rares: 5,
  components: 2,
  fuel: 1,
};

const ecoCityStates: TimelineCityState[] = country.cities.map(city => ({
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

const ecoBuildOrder: BuildAction[] = [];
for (const city of country.cities) {
  const cityId = `${country.country.id}:${city.id}`;
  const aiTarget = AI_TARGET_BY_RESOURCE[city.resource];
  ecoBuildOrder.push({ cityId, buildingId: "recruiting_office", targetLevel: 1 });
  ecoBuildOrder.push({ cityId, buildingId: "arms_industry", targetLevel: aiTarget });
}

const ecoSegmentsByCity = scheduleBuildSegments({ cities: ecoCityStates, buildOrder: ecoBuildOrder, buildings, scenario });

function ecoStepsAndCompletion(bareCityId: string): { rows: Array<Record<string, unknown>>; completionAbsHour: number } {
  const prefixedId = `${country.country.id}:${bareCityId}`;
  const segs = ecoSegmentsByCity.get(prefixedId);
  const allSegs = [...(segs?.recruiting_office ?? []), ...(segs?.arms_industry ?? [])].sort(
    (a, b) => a.startMinute - b.startMinute
  );
  const rows = allSegs.map((s, i) => ({
    "#": i + 1,
    at: fmtAbsHour(s.startMinute / 60),
    step: `[eco] ${s.buildingId.replaceAll("_", " ")} L${s.toLevel}`,
  }));
  const completionAbsHour = allSegs.length === 0 ? scenarioAbsHour : Math.max(...allSegs.map(s => s.endMinute)) / 60;
  return { rows, completionAbsHour };
}

// ── Force projection (existing Unit 2 engine, unmodified) ─────────────────────

const countryPlan = plan.countries[countryId];
const status = countryPlan?.status ?? "homeland";

const result = computeCountryForceProjection({
  country,
  doctrine: country.country.doctrine,
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

// ── Resource balance inputs ────────────────────────────────────────────────

const hoursToSimulate = plan.truce_days * 24;

function zeroResources(): Record<Resource, number> {
  return { supplies: 0, components: 0, fuel: 0, rares: 0, electronics: 0, cash: 0, manpower: 0 };
}

function addInto(target: Record<Resource, number>, src: ResourceCost): void {
  for (const r of RESOURCE_KEYS) target[r] += src[r] ?? 0;
}

function buildingLevelCost(buildingId: string, level: number): ResourceCost {
  return buildings.buildings[buildingId as keyof typeof buildings.buildings]?.levels[String(level) as "1" | "2" | "3" | "4" | "5"]?.cost ?? {};
}

// Full-window per-hour production for the (unchanged) iron eco build — needed to
// flip-truncate each city's income at its own flip point below.
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
const citySimulation = simulateBuildOrder({ cities: fullCityStates, buildOrder: ecoBuildOrder, buildings, scenario, hoursToSimulate });
const hourlyProductionByCity = new Map<string, Array<Record<Resource, number>>>();
for (const city of country.cities) hourlyProductionByCity.set(`${country.country.id}:${city.id}`, []);
for (const row of citySimulation.perHourPerCity) {
  hourlyProductionByCity.get(row.cityId)?.push(row.production);
}

// Same through-flip-then-flat formula as city-eco-income.ts's cityIncomeThroughFlip.
function cityIncomeThroughFlip(bareCityId: string, flipRelHour: number): Record<Resource, number> {
  const hourly = hourlyProductionByCity.get(`${country.country.id}:${bareCityId}`) ?? [];
  const total = zeroResources();
  const flipH = Math.max(0, Math.min(Math.round(flipRelHour), hoursToSimulate));
  for (let h = 0; h < flipH; h++) addInto(total, hourly[h] ?? {});
  const rateAtFlip = hourly[Math.max(0, flipH - 1)] ?? hourly[0] ?? {};
  const remainingHours = hoursToSimulate - flipH;
  if (remainingHours > 0) {
    for (const r of RESOURCE_KEYS) total[r] += (rateAtFlip[r] ?? 0) * remainingHours;
  }
  return total;
}

// City eco build cost (RO1 + AI-to-target) — same builds as iron-eco-italy.html.
const cityEcoBuildCost = zeroResources();
for (const city of country.cities) {
  const aiTarget = AI_TARGET_BY_RESOURCE[city.resource];
  addInto(cityEcoBuildCost, buildingLevelCost("recruiting_office", 1));
  for (let lvl = 1; lvl <= aiTarget; lvl++) addInto(cityEcoBuildCost, buildingLevelCost("arms_industry", lvl));
}

// Province income + build cost — same rule as iron-eco-italy.html: beam sequence
// kept for supplies/electronics cohorts, base-only (no build) for everything else.
const provinceCohorts = buildProvinceCohortsFromCountry(country);
const PROVINCE_BUILD_ORDER: Record<string, Array<{ buildingId: "local_industry" | "combat_outpost"; targetLevel: number }>> = {
  supplies: [
    { buildingId: "local_industry", targetLevel: 1 },
    { buildingId: "local_industry", targetLevel: 2 },
    { buildingId: "local_industry", targetLevel: 3 },
    { buildingId: "combat_outpost", targetLevel: 1 },
  ],
  electronics: [
    { buildingId: "local_industry", targetLevel: 1 },
    { buildingId: "local_industry", targetLevel: 2 },
    { buildingId: "combat_outpost", targetLevel: 1 },
    { buildingId: "local_industry", targetLevel: 3 },
  ],
};
const provinceIncome = zeroResources();
const provinceBuildCost = zeroResources();
for (const cohort of provinceCohorts) {
  const steps = (cohort.resource && PROVINCE_BUILD_ORDER[cohort.resource]) ?? [];
  const actions: ProvinceBuildAction[] = steps.map(s => ({ provinceId: cohort.provinceId, buildingId: s.buildingId, targetLevel: s.targetLevel }));
  const simResult = simulateProvinceBuildOrder({ provinces: [{ ...cohort, cityStatus: "homeland" }], buildOrder: actions, buildings, scenario, hoursToSimulate });
  const cohortIncome = zeroResources();
  for (const row of simResult.perHourAggregate) addInto(cohortIncome, row.production);
  // Manpower workaround: simulateProvinceBuildOrder floors production hourly
  // (floorInt(dailyAmount/24)), which zeroes manpower for small cohorts — same
  // bug/fix as iron-eco-plan.ts. Recompute from the daily-granularity table.
  cohortIncome.manpower = buildDailyProvinceResourceTable(plan.truce_days, scenario.speed, {
    resource: "manpower",
    provinceCount: cohort.totalProvinceCount,
    moraleParams: { S: STARTING_MORALE_DAY1, T: HOMELAND_TARGET_MORALE, N: 0, D: DEFAULT_MORALE_DECAY_D },
    cityStatus: "homeland",
  }).total;
  addInto(provinceIncome, cohortIncome);
  for (const step of steps) addInto(provinceBuildCost, buildingLevelCost(step.buildingId, step.targetLevel));
}

// ── Resource balance (pass 1 over citySlots: accumulate only, no HTML yet) ────

const feasible = !(result.reason === "no_demands" || result.reason === "no_active_demands" || result.citySlots.length === 0);

const flipTruncatedCityIncome = zeroResources();
const ro2BackfillCost = zeroResources();
const armyBaseCost = zeroResources();

if (feasible) {
  for (const slot of result.citySlots) {
    const { completionAbsHour } = ecoStepsAndCompletion(slot.cityId);
    const roStep = slot.infraSteps.find((s: InfraStep) => s.buildingId === "recruiting_office" && s.toLevel === slot.roLevel);
    const otherSteps = slot.infraSteps.filter(
      (s: InfraStep) => s.buildingId !== "recruiting_office" && s.buildingId !== "arms_industry"
    );
    if (roStep && roStep.toLevel > 1) addInto(ro2BackfillCost, roStep.cost);
    for (const step of otherSteps) addInto(armyBaseCost, step.cost);

    const flipAbsHour = slot.mobSteps.length > 0 ? slot.mobSteps[0].startAbsHour : completionAbsHour;
    addInto(flipTruncatedCityIncome, cityIncomeThroughFlip(slot.cityId, flipAbsHour - scenarioAbsHour));
  }
}

const startingBalance = zeroResources();
for (const r of RESOURCE_KEYS) startingBalance[r] = country.starting_balance?.[r] ?? 0;

const garrisonDisbandAbsHour = toAbsoluteHour(4, 0);
const garrisonUpkeep = zeroResources();
addInto(garrisonUpkeep, computeGarrisonUpkeep(scenario, catalog, country.country.doctrine, scenarioAbsHour, garrisonDisbandAbsHour).totalUpkeep);

const ecoIncomeTotal = zeroResources();
addInto(ecoIncomeTotal, flipTruncatedCityIncome);
addInto(ecoIncomeTotal, provinceIncome);

// Infra Costs: every building actually constructed in the integrated plan
// (eco + RO2 backfill + province builds + army_base), regardless of which
// phase it happened in — the eco-vs-force split was only ever an internal
// computation detail, not a meaningful category to show separately.
const infraCostTotal = zeroResources();
addInto(infraCostTotal, cityEcoBuildCost);
addInto(infraCostTotal, ro2BackfillCost);
addInto(infraCostTotal, provinceBuildCost);
addInto(infraCostTotal, armyBaseCost);

const mobilisationCostTotal = zeroResources();
addInto(mobilisationCostTotal, result.costs.mobilisation);
addInto(mobilisationCostTotal, result.costs.provinceMobilisation);

// Upkeep Costs: garrison upkeep folded in here rather than shown separately —
// it's not meaningfully distinct from force upkeep.
const upkeepCostTotal = zeroResources();
addInto(upkeepCostTotal, result.costs.upkeep);
addInto(upkeepCostTotal, result.costs.provinceUpkeep);
addInto(upkeepCostTotal, garrisonUpkeep);

const netBalance = zeroResources();
for (const r of RESOURCE_KEYS) {
  netBalance[r] = startingBalance[r] + ecoIncomeTotal[r] - infraCostTotal[r] - mobilisationCostTotal[r] - upkeepCostTotal[r];
}

function balanceRow(label: string, values: Record<Resource, number>, bold = false): string {
  const cells = RESOURCE_KEYS.map(r => `<td>${fmt(Math.round(values[r]))}</td>`).join("");
  return bold ? `<tr><td><strong>${escapeHtml(label)}</strong></td>${cells}</tr>` : `<tr><td>${escapeHtml(label)}</td>${cells}</tr>`;
}

let resourceBalanceHtml = `<h2>Resource Balance</h2>\n<p class="label">Manpower is not pooled — checked per-country only. Computed directly from this integrated build plan (flip-truncated eco income at each city's unchanged flip point).</p>\n`;
resourceBalanceHtml += `<table><thead><tr><th></th>${RESOURCE_KEYS.map(r => `<th>${r}</th>`).join("")}</tr></thead><tbody>`;
resourceBalanceHtml += balanceRow("Starting Balance", startingBalance, true);
resourceBalanceHtml += balanceRow("Eco Income", ecoIncomeTotal, true);
resourceBalanceHtml += balanceRow("Infra Costs", infraCostTotal, true);
resourceBalanceHtml += balanceRow("Mobilisation Costs", mobilisationCostTotal, true);
resourceBalanceHtml += balanceRow("Upkeep Costs", upkeepCostTotal, true);
resourceBalanceHtml += `<tr><td><strong>= Net Balance</strong></td>${RESOURCE_KEYS.map(r => {
  const v = Math.round(netBalance[r]);
  const color = v < 0 ? "#cf222e" : "#1a7f37";
  return `<td style="color:${color};font-weight:600">${fmt(v)}</td>`;
}).join("")}</tr>`;
resourceBalanceHtml += `</tbody></table>\n`;

// ── Resource Minima (hourly cash-flow walk) — approximate, country-level ─────
// Same documented caveat as resource-projection.ts's version: continuous
// upkeep-rate approximation (not the exact stepped rate), province income
// spread as a flat average rather than day-varying — a shortfall detector, not
// a bit-exact reconciliation of the totals above. Country-level (not pooled),
// so manpower is included, unlike the coalition-pooled version.

// Cost timing (all confirmed against real game mechanics):
//  - Queued buildings spend resources when the build STARTS, not completes.
//  - Mobilisation cost for a unit is deducted as that unit STARTS mobilising —
//    a batch of N units is N separate per-unit payments spread across the
//    batch's duration, not one lump sum for all N at batch start.
//  - Upkeep for a unit begins the moment it COMPLETES mobilisation (unaffected
//    by when the rest of its batch finishes).
type CostEvent = { hour: number; cost: Partial<Record<Resource, number>> };
const costEvents: CostEvent[] = [];

for (const city of country.cities) {
  const prefixedId = `${country.country.id}:${city.id}`;
  const segs = ecoSegmentsByCity.get(prefixedId);
  for (const s of [...(segs?.recruiting_office ?? []), ...(segs?.arms_industry ?? [])]) {
    costEvents.push({ hour: s.startMinute / 60, cost: buildingLevelCost(s.buildingId, s.toLevel) });
  }
}
// Upkeep: reuses computeSteppedUpkeep (the same event-based, research-level-
// aware integration the real result.costs.upkeep total is built from) rather
// than re-deriving a parallel approximation — per user direction. Since it
// only returns a cumulative total for a given deadline, per-hour charges are
// derived by calling it at each hour and differencing consecutive totals.
// Known simplification: treats each mob step's `count` as `count` individual
// 1-unit events (unitsPerEvent=1) — exactly correct for every unit in this
// plan (none are batch units); batch units (e.g. warheads, batchSize 4)
// would need unitsPerEvent from `demandResults`, not available here.
const upkeepPerHourByRelHour: Array<Record<Resource, number>> = Array.from({ length: hoursToSimulate }, zeroResources);

if (feasible) {
  for (const slot of result.citySlots) {
    const { completionAbsHour } = ecoStepsAndCompletion(slot.cityId);
    const roStep = slot.infraSteps.find((s: InfraStep) => s.buildingId === "recruiting_office" && s.toLevel === slot.roLevel);
    const otherSteps = slot.infraSteps.filter(
      (s: InfraStep) => s.buildingId !== "recruiting_office" && s.buildingId !== "arms_industry"
    );
    if (roStep && roStep.toLevel > 1) costEvents.push({ hour: completionAbsHour, cost: roStep.cost });
    for (const step of otherSteps) costEvents.push({ hour: step.startHour, cost: step.cost });
    for (const m of slot.mobSteps) {
      const perUnitHours = m.count > 0 ? (m.endAbsHour - m.startAbsHour) / m.count : 0;
      const perUnitCost = calculateMobilizationCost(m.unitId, 1, 1, catalog, country.country.doctrine);
      for (let i = 0; i < m.count; i++) {
        costEvents.push({ hour: m.startAbsHour + i * perUnitHours, cost: perUnitCost });
      }

      if (m.count > 0) {
        const levelSteps = getLevelSteps(m.unitId, result.researchSegments);
        const startRelHour = Math.max(0, Math.floor(m.startAbsHour - scenarioAbsHour));
        let prevCumulative: ResourceCost = {};
        for (let h = startRelHour; h < hoursToSimulate; h++) {
          const cumulative = computeSteppedUpkeep(
            m.unitId,
            country.country.doctrine,
            m.startAbsHour,
            m.count,
            1,
            perUnitHours,
            scenarioAbsHour + h + 1,
            levelSteps,
            catalog
          );
          for (const r of RESOURCE_KEYS) {
            const delta = (cumulative[r] ?? 0) - (prevCumulative[r] ?? 0);
            if (delta) upkeepPerHourByRelHour[h][r] += delta;
          }
          prevCumulative = cumulative;
        }
      }
    }
  }
}
costEvents.sort((a, b) => a.hour - b.hour);

function unitUpkeepPerHour(absHour: number): Record<Resource, number> {
  const relHour = absHour - scenarioAbsHour;
  if (relHour < 0 || relHour >= hoursToSimulate) return zeroResources();
  return upkeepPerHourByRelHour[relHour];
}

function incomeAtHour(absHour: number): Record<Resource, number> {
  const total = zeroResources();
  if (feasible) {
    for (const slot of result.citySlots) {
      const hourly = hourlyProductionByCity.get(`${country.country.id}:${slot.cityId}`) ?? [];
      const relHour = absHour - scenarioAbsHour;
      const flipAbsHour = slot.mobSteps.length > 0 ? slot.mobSteps[0].startAbsHour : deadlineAbsHour;
      const flipRel = flipAbsHour - scenarioAbsHour;
      const idx = relHour < flipRel ? relHour : Math.max(0, Math.round(flipRel) - 1);
      const prod = hourly[idx] ?? {};
      for (const r of RESOURCE_KEYS) total[r] += prod[r] ?? 0;
    }
  }
  for (const r of RESOURCE_KEYS) total[r] += provinceIncome[r] / hoursToSimulate;
  return total;
}

const garrisonHourlyRate = zeroResources();
const garrisonWindowHours = Math.max(1, garrisonDisbandAbsHour - scenarioAbsHour);
for (const r of RESOURCE_KEYS) garrisonHourlyRate[r] = garrisonUpkeep[r] / garrisonWindowHours;

const running = zeroResources();
for (const r of RESOURCE_KEYS) running[r] = startingBalance[r];
const minima = {} as Record<Resource, { value: number; hour: number }>;
for (const r of RESOURCE_KEYS) minima[r] = { value: startingBalance[r], hour: scenarioAbsHour };
const firstNegative = {} as Record<Resource, { value: number; hour: number } | undefined>;
for (const r of RESOURCE_KEYS) firstNegative[r] = startingBalance[r] < 0 ? { value: startingBalance[r], hour: scenarioAbsHour } : undefined;

let eventIdx = 0;
for (let h = scenarioAbsHour; h < deadlineAbsHour; h++) {
  const inc = incomeAtHour(h);
  const uk = unitUpkeepPerHour(h);
  for (const r of RESOURCE_KEYS) {
    running[r] += inc[r] - uk[r];
    if (h < garrisonDisbandAbsHour) running[r] -= garrisonHourlyRate[r];
  }
  while (eventIdx < costEvents.length && Math.floor(costEvents[eventIdx].hour) <= h) {
    for (const r of RESOURCE_KEYS) running[r] -= costEvents[eventIdx].cost[r] ?? 0;
    eventIdx++;
  }
  for (const r of RESOURCE_KEYS) {
    if (running[r] < minima[r].value) minima[r] = { value: running[r], hour: h };
    if (firstNegative[r] === undefined && running[r] < 0) firstNegative[r] = { value: running[r], hour: h };
  }
}

let resourceMinimaHtml = `<h2>Resource Minima (hourly cash-flow walk)</h2>\n`;
resourceMinimaHtml += `<p class="label">Country-level (manpower included, unlike the coalition-pooled version). "First negative" is the earliest hour the running balance dips below zero (— if it never does); "Minima" is the lowest point over the whole window. Approximate: flat-average province income rather than day-varying — a shortfall detector, not a bit-exact reconciliation of the totals above.</p>\n`;
resourceMinimaHtml += renderTable(
  RESOURCE_KEYS.map(r => ({
    resource: r,
    "first-neg hour": firstNegative[r] ? fmtAbsHour(firstNegative[r]!.hour) : "—",
    "first-neg value": firstNegative[r] ? fmt(Math.round(firstNegative[r]!.value)) : "—",
    "minima hour": fmtAbsHour(minima[r].hour),
    "minima value": fmt(Math.round(minima[r].value)),
  })),
  ["resource", "first-neg hour", "first-neg value", "minima hour", "minima value"]
);

// ── Integration ─────────────────────────────────────────────────────────────

let html = `<h1>${escapeHtml(result.countryName)} — Iron Build Plan</h1>\n`;
html += `<p class="label">Doctrine: ${escapeHtml(country.country.doctrine)} · Status: ${escapeHtml(status)} `;
html += `· Deadline: ${fmtAbsHour(deadlineAbsHour)} (${plan.truce_days} days) · morale ${result.moraleAtStart}%&rarr;${result.moraleAtDeadline}%</p>\n`;
html += `<p class="label">Integrates the iron eco build (unchanged) with the existing Unit 2 force-projection engine (unchanged): RO2 backfilled to the earliest free point after eco, arms_industry dropped (already covered by eco), army_base carried over unaltered, mob queue timing unchanged (JIT/deadline-anchored).</p>\n`;

if (!feasible) {
  html += `<p class="infeasible">No feasible city allocation.</p>\n`;
} else {
  html += resourceBalanceHtml;
  html += resourceMinimaHtml;

  html += `<h2>Research</h2>\n`;
  html += `<p class="label">Two research slots run concurrently and independently — shown as separate tables rather than one interleaved table.</p>\n`;
  html += `<div class="pair">\n`;
  for (const slotNum of [1, 2]) {
    const researchRows = result.researchSegments
      .filter(s => s.slot === slotNum)
      .slice()
      .sort((a, b) => a.startAbsoluteHour - b.startAbsoluteHour)
      .map(s => ({
        unit: s.unitId.replaceAll("_", " "),
        level: s.level,
        start: fmtAbsHour(s.startAbsoluteHour),
        complete: fmtAbsHour(s.endAbsoluteHourExclusive),
        duration: `${s.durationHours}h`,
      }));
    html += `<div><h3>Slot ${slotNum}</h3>\n`;
    html += renderTable(researchRows, ["unit", "level", "start", "complete", "duration"]);
    html += `</div>\n`;
  }
  html += `</div>\n`;

  html += `<h2>Build Plan</h2>\n`;
  html += `<p class="label">"[eco]" steps are the unchanged iron eco build; "[eco-backfill]" is RO2 pulled forward to the earliest free point (manpower bonus from day 1 of being built, so no benefit to delaying it); "[infra]" steps (e.g. army_base) keep their exact original force-projection timestamps unaltered — they have no standalone benefit, so building them early would only add upkeep for no gain, leaving a genuine idle gap before them. Build Queue (infra) and Mobilisation Queue (units) are genuinely separate parallel queues, shown as separate tables.</p>\n`;

  for (const slot of result.citySlots) {
    const city = country.cities.find(c => c.id === slot.cityId);
    const cityLabel = city ? `${city.name} (${city.resource})` : slot.cityId;

    const { rows: ecoRows, completionAbsHour } = ecoStepsAndCompletion(slot.cityId);
    const buildQueueRows: Array<Record<string, unknown>> = [...ecoRows];

    // Eco already covers RO1 — from-scratch fp chain lists both RO0→1 and RO1→2
    // steps (it doesn't know that), so pick specifically the step that reaches
    // the target roLevel, not just the first recruiting_office step found.
    const roStep = slot.infraSteps.find((s: InfraStep) => s.buildingId === "recruiting_office" && s.toLevel === slot.roLevel);
    const otherSteps = slot.infraSteps.filter(
      (s: InfraStep) => s.buildingId !== "recruiting_office" && s.buildingId !== "arms_industry"
    );

    // Only RO2 is backfilled to the earliest free point (it's the one step with
    // a standalone benefit — manpower bonus — from the moment it's built). Every
    // other required step (army_base etc.) has no benefit until it's actually
    // needed, so building it early would only add upkeep for no gain — keep it
    // at its exact original force-projection timestamps, unaltered.
    let backfillEndAbsHour = completionAbsHour;
    if (roStep && roStep.toLevel > 1) {
      const start = completionAbsHour;
      const end = start + roStep.durH;
      buildQueueRows.push({ "#": buildQueueRows.length + 1, at: fmtAbsHour(start), step: `[eco-backfill] recruiting office L${roStep.toLevel}` });
      backfillEndAbsHour = end;
    }
    for (const step of otherSteps) {
      buildQueueRows.push({ "#": buildQueueRows.length + 1, at: fmtAbsHour(step.startHour), step: `[infra] ${step.name}` });
    }

    const flipAbsHour = slot.mobSteps.length > 0 ? slot.mobSteps[0].startAbsHour : backfillEndAbsHour;
    const mobQueueRows = slot.mobSteps.map((m, i) => ({
      "#": i + 1,
      at: fmtAbsHour(m.startAbsHour),
      step: `[mob] ${m.unitId.replaceAll("_", " ")} ×${m.count}`,
    }));

    html += `<h3>${escapeHtml(cityLabel)} — ${escapeHtml(slot.primaryUnitId.replaceAll("_", " "))}, RO L${slot.roLevel}</h3>\n`;
    const earliestOtherStart = otherSteps.length > 0 ? Math.min(...otherSteps.map((s: InfraStep) => s.startHour)) : undefined;
    if (earliestOtherStart !== undefined && backfillEndAbsHour > earliestOtherStart) {
      html += `<p class="infeasible">WARNING: RO2 backfill (ends ${fmtAbsHour(backfillEndAbsHour)}) runs past the original infra start (${fmtAbsHour(earliestOtherStart)}).</p>\n`;
    }
    html += `<p class="label"><strong>Flip point: ${fmtAbsHour(flipAbsHour)}</strong> — eco/build until then, mobilisation after.</p>\n`;
    html += `<div class="pair">\n`;
    html += `<div><h4>Build Queue</h4>\n`;
    html += renderTable(buildQueueRows, ["#", "at", "step"]);
    html += `</div>\n`;
    html += `<div><h4>Mobilisation Queue</h4>\n`;
    html += renderTable(mobQueueRows, ["#", "at", "step"]);
    html += `</div>\n`;
    html += `</div>\n`;
  }

  html += `<h2>Force Projection</h2>\n`;
  html += `<p class="label">${escapeHtml(result.demandLabels.join(" · "))}</p>\n`;
  if (result.infeasible) {
    html += `<p class="infeasible">INFEASIBLE — no cities allocated.</p>\n`;
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
      .map(d => `<li class="infeasible">${escapeHtml(d.unitId)} × ${d.count} — no ${escapeHtml(country.country.doctrine)} mobilisation data</li>`)
      .join("")}</ul>\n`;
  }
  if (skipped.length > 0) {
    html += `<h2>Skipped Demands</h2>\n`;
    html += `<ul>${skipped.map(s => `<li class="skipped">${escapeHtml(s)}</li>`).join("")}</ul>\n`;
  }
}

fs.mkdirSync(path.resolve("tmp"), { recursive: true });
const outHtml = buildHtml(`Iron Build Plan — ${country.country.name}`, html);
const outPath = path.resolve("tmp/iron-bp-italy.html");
fs.writeFileSync(outPath, outHtml, "utf8");
console.log(`→ wrote ${outPath}`);
