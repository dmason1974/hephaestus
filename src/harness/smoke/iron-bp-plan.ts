// Integration step: combines the iron eco build (iron-eco-<country>.html, untouched)
// with the existing, trusted Unit 2 force-projection engine (iron-fp-<country>.html)
// into one "build plan" HTML, matching bp-<country>.html's format.
// Run via IRON_COUNTRY=<id> npm run smoke:iron-bp-plan. Manual integration
// rules (per user direction, not derived by any engine change):
//   - RO2 (wherever the force projection specified it) is backfilled to the
//     earliest point the eco phase's build queue is actually free — day 2 h01 for
//     components/fuel cities (AI1-only eco build), day 9 h05 for the rest (AI5 eco
//     build) — instead of the force projection's original (late, post-flip) timing.
//   - arms_industry from the force projection's infra chain is dropped entirely —
//     already covered by the eco build (and a no-op either way, since
//     scheduleBuildSegments skips any action whose targetLevel <= currentLevel).
//   - Every other infra step (army_base etc.) carries over unaltered — same
//     target levels, same durations as the force projection computed. For a
//     genuine dead-window city (`isDeadWindowSlot` — a primary unit sharing its
//     mob queue with a filler whose requirements are a strict subset, e.g.
//     Japan/India's SASF+AWACS/UAV/warhead cities) these steps ARE repositioned
//     immediately after the RO2 backfill, since finishing the chain earlier makes
//     the filler mobilisation-eligible sooner — a real benefit. For an ordinary
//     single-unit-queue city (every MRL/MAAV ground-build city) there is no filler
//     to benefit, so these steps are left at Unit 2's own JIT timing (finishing
//     right as mobilisation starts) instead — repositioning them earlier there was
//     a real bug: army_base has a genuine daily_upkeep cost, so building it up to
//     two weeks before it's used just burns cash for nothing.
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
  getUnitBuildingRequirements,
  isDeadWindowSlot,
  type InfraStep,
} from "../../engine/optimization/country-force-projection.js";
import { calculateMobilizationCost, calculateUpkeepCost } from "../../engine/optimization/cost-calculator.js";
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
import { AI_TARGET_BY_RESOURCE, PROVINCE_BUILD_ORDER } from "./iron-heuristic.js";

const scenarioId = process.env.IRON_SCENARIO ?? "elite/antarctica";
const planId = process.env.IRON_PLAN ?? "pnth-v-iron-2026-aug";
const countryId = process.env.IRON_COUNTRY;
if (!countryId) {
  throw new Error("IRON_COUNTRY is required, e.g. IRON_COUNTRY=south_africa npm run smoke:iron-bp-plan");
}
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

// ── Eco phase (identical to iron-eco-plan.ts — shares iron-heuristic.ts) ──────

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

// ── Shifted infra/mob timing (RO2 backfill must genuinely precede the rest of
// the infra chain; RO3+ is deferred to the end, after secret_weapons_lab) ─────
//
// Only RO2 has a standalone benefit from the moment it's built (manpower bonus)
// — the file's own original design comment already said as much ("Only RO2 is
// backfilled... it's the one step with a standalone benefit"), even though the
// code backfilled every hop up to slot.roLevel. RO3+ has no such benefit before
// it's actually needed, so — per the user's direction — it's deferred to build
// AFTER secret_weapons_lab instead of being pulled forward with RO2. This
// matters for feasibility, not just tidiness: pulling RO3 forward (with air_base
// now starting earlier post the secret_weapons_lab-after-air_base fix) pushed
// the whole chain's completion past some cities' deadline-anchored SASF mob
// start; deferring RO3 to the very end shortens the pre-mobilisation chain by
// RO3's own duration.
//
// `chainSteps` (air_base, secret_weapons_lab, then any RO3+ hops last) are
// genuinely re-sequenced back-to-back starting right after the RO2 backfill —
// not just uniformly shifted by a delta, since RO3+ moved to a different
// position in the sequence than Unit 2 originally put it in. Every mob step's
// start floor — including the primary's — is re-derived from the shifted
// completion of its own required building: per user direction, a residual gap
// between the primary's deadline-anchored start and its own (rescheduled)
// infra completion should just delay the primary by that amount ("that is what
// will happen in practice") rather than being flagged as a warning. This can
// only push a start later, never earlier, so it can't turn a feasible plan
// infeasible.
type ShiftedSlotTiming = {
  roStep: InfraStep | undefined;
  otherSteps: InfraStep[];
  backfillEndAbsHour: number;
  mobSteps: (typeof result.citySlots)[number]["mobSteps"];
};

const shiftedTimingByCity = new Map<string, ShiftedSlotTiming>();
for (const slot of result.citySlots) {
  const { completionAbsHour } = ecoStepsAndCompletion(slot.cityId);

  // Eco already credits RO L1. Only the L1→L2 hop is pulled forward as the
  // backfill (RO2's standalone manpower benefit); any hop beyond L2 (L2→L3,
  // L3→L4, ...) is deferred — see chainSteps below.
  const ro2Hop = slot.infraSteps.find((s: InfraStep) => s.buildingId === "recruiting_office" && s.toLevel === 2 && s.toLevel <= slot.roLevel);
  const deferredRoHops = slot.infraSteps
    .filter((s: InfraStep) => s.buildingId === "recruiting_office" && s.toLevel > 2 && s.toLevel <= slot.roLevel)
    .sort((a, b) => a.toLevel - b.toLevel);
  const roStep: InfraStep | undefined = ro2Hop
    ? { ...ro2Hop, name: "recruiting office L2", startHour: completionAbsHour, endHour: completionAbsHour + ro2Hop.durH }
    : undefined;
  const backfillEndAbsHour = roStep ? roStep.endHour : completionAbsHour;

  // Only reschedule when there's an actual RO2 backfill to place — a city with
  // RO L1 (no backfill at all, e.g. Japan's AWACS-sharing cities) has nothing to
  // resolve here, so its otherSteps/mobSteps must stay exactly as Unit 2
  // computed them. Rescheduling unconditionally (an earlier version of this fix
  // did) was itself a bug: it forced otherSteps to start at completionAbsHour
  // even when Unit 2's own original chain already started earlier (or had a
  // different, already-correct timing this iron-eco-derived value knows nothing
  // about) — confirmed regressing Japan's already-validated dead-window AWACS
  // sharing (Tokyo showed an 84h gap that doesn't exist in Unit 2's own output).
  const rawOtherSteps = slot.infraSteps
    .filter((s: InfraStep) => s.buildingId !== "recruiting_office" && s.buildingId !== "arms_industry")
    .sort((a, b) => a.startHour - b.startHour);

  // Rescheduling otherSteps earlier only has a real benefit for a genuine
  // dead-window city — a primary unit sharing its mob queue with a filler whose
  // requirements are a strict subset (isDeadWindowSlot), where an earlier chain
  // completion makes the filler mobilisation-eligible sooner. For an ordinary
  // single-unit-queue city there's no filler to benefit, so pulling army_base etc.
  // forward was pure waste — army_base has a real daily_upkeep cost, so finishing
  // it up to two weeks before mobilisation actually starts just burns cash sitting
  // idle. deferredRoHops (RO3+) still needs a placement even in that case, so it
  // keeps the old re-chain behavior — no current city hits that combination, but
  // this avoids introducing an unexercised code path for it.
  const isDeadWindow = isDeadWindowSlot(slot.mobQueue, catalog, buildings);

  // air_base + secret_weapons_lab (Unit 2's own relative order preserved),
  // then any deferred RO3+ hops last — re-sequenced back-to-back from
  // backfillEndAbsHour, not just uniformly shifted (RO3+ changed position).
  const otherSteps: InfraStep[] = roStep && (isDeadWindow || deferredRoHops.length > 0)
    ? (() => {
        const chainSteps = [...rawOtherSteps, ...deferredRoHops];
        let cursor = backfillEndAbsHour;
        return chainSteps.map((s: InfraStep) => {
          const start = cursor;
          const end = start + s.durH;
          cursor = end;
          return { ...s, name: s.buildingId === "recruiting_office" ? `recruiting office L${s.toLevel}` : s.name, startHour: start, endHour: end };
        });
      })()
    : rawOtherSteps;

  // Mob-start floors only need re-deriving when otherSteps was actually
  // rescheduled (same gate as otherSteps above) — otherwise otherSteps is
  // untouched Unit 2 output and slot.mobSteps is already consistent with it.
  // Applies to the primary unit too now (not just fillers) — per user direction, a
  // small residual gap between the primary's deadline-anchored mob start and its
  // own infra chain's (rescheduled) completion should just delay the primary by
  // that amount rather than being flagged as a warning; this can only push a
  // start later; never earlier, so it can't turn a feasible plan infeasible.
  const mobSteps = roStep && (isDeadWindow || deferredRoHops.length > 0)
    ? slot.mobSteps
        .map(m => {
          const reqs = getUnitBuildingRequirements(m.unitId, catalog, buildings);
          let readinessFloor = scenarioAbsHour;
          for (const [buildingId, level] of reqs) {
            if (buildingId === "recruiting_office" || buildingId === "arms_industry") continue;
            const step = otherSteps.find((s: InfraStep) => s.buildingId === buildingId && s.toLevel === level);
            if (step) readinessFloor = Math.max(readinessFloor, step.endHour);
          }
          const newStart = Math.max(m.startAbsHour, readinessFloor);
          return { ...m, startAbsHour: newStart, endAbsHour: newStart + m.durationHours };
        })
        // Shifting a filler's start later can change relative ordering — downstream
        // code (e.g. `mobSteps[0]` as the flip point) assumes ascending start order.
        .sort((a, b) => a.startAbsHour - b.startAbsHour)
    : slot.mobSteps;

  shiftedTimingByCity.set(slot.cityId, { roStep, otherSteps, backfillEndAbsHour, mobSteps });
}

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

const citySimulation = simulateBuildOrder({ cities: fullCityStates, buildOrder: ecoBuildOrder, buildings, scenario, hoursToSimulate, forcedAirBaseDestructionAbsHour });
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

// Province income + build cost — same rule as iron-eco-plan.ts: build sequence
// kept for supplies/electronics cohorts, base-only (no build) for everything else.
const provinceCohorts = buildProvinceCohortsFromCountry(country);
const provinceIncome = zeroResources();
const provinceBuildCost = zeroResources();
// Province build costs were previously computed for the Resource Balance totals
// (provinceBuildCost, below) but never fed into the hourly cash-flow walk's
// costEvents — a real reconciliation gap (confirmed via a diagnostic probe on
// Norway: walked cost exactly matched infraCostTotal for fuel/rares/electronics
// but was short by exactly the missing local_industry/combat_outpost cost for
// supplies/components/cash — those two buildings only cost those three
// resources, which is what pinpointed the omission). scheduleBuildSegments is
// called directly here (same as simulateProvinceBuildOrder does internally) just
// to get each province build step's real start hour for costEvents timing.
const provinceCostEvents: Array<{ hour: number; cost: ResourceCost }> = [];
for (const cohort of provinceCohorts) {
  const steps = (cohort.resource && PROVINCE_BUILD_ORDER[cohort.resource]) ?? [];
  const actions: ProvinceBuildAction[] = steps.map(s => ({ provinceId: cohort.provinceId, buildingId: s.buildingId, targetLevel: s.targetLevel }));
  const simResult = simulateProvinceBuildOrder({ provinces: [{ ...cohort, cityStatus: "homeland" }], buildOrder: actions, buildings, scenario, hoursToSimulate });
  const provinceTimelineState: TimelineCityState = {
    cityId: cohort.provinceId,
    countryId: country.country.id,
    buildings: {
      army_base: 0, air_base: 0, annex_city: 0, arms_industry: 0,
      combat_outpost: 0, local_industry: 0, mercenary_outpost: 0,
      naval_base: 0, recruiting_office: 0, relocate_headquarters: 0, underground_bunkers: 0,
    },
  };
  const provinceSegments = scheduleBuildSegments({ cities: [provinceTimelineState], buildOrder: actions.map(a => ({ cityId: a.provinceId, buildingId: a.buildingId, targetLevel: a.targetLevel })), buildings, scenario });
  const segs = provinceSegments.get(cohort.provinceId);
  for (const s of [...(segs?.local_industry ?? []), ...(segs?.combat_outpost ?? [])]) {
    provinceCostEvents.push({ hour: s.startMinute / 60, cost: buildingLevelCost(s.buildingId, s.toLevel) });
  }
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
const assignedCityIds = new Set<string>();

if (feasible) {
  for (const slot of result.citySlots) {
    assignedCityIds.add(slot.cityId);
    const { completionAbsHour } = ecoStepsAndCompletion(slot.cityId);
    const { roStep, otherSteps, mobSteps } = shiftedTimingByCity.get(slot.cityId)!;
    if (roStep && roStep.toLevel > 1) addInto(ro2BackfillCost, roStep.cost);
    for (const step of otherSteps) addInto(armyBaseCost, step.cost);

    const flipAbsHour = mobSteps.length > 0 ? mobSteps[0].startAbsHour : completionAbsHour;
    addInto(flipTruncatedCityIncome, cityIncomeThroughFlip(slot.cityId, flipAbsHour - scenarioAbsHour));
  }
}

// Cities the fold-in never assigned a military demand to still exist and still
// produce eco income for the full truce window under the iron heuristic — nothing
// ever flips them to military infra, so nothing should truncate their income.
// Previously silently dropped to zero here while their build cost
// (cityEcoBuildCost, below) was already counted for every city regardless of
// assignment — a real income/cost mismatch. Confirmed via Japan (3 of 7 cities
// unassigned) showing a components net balance an order of magnitude worse than
// India (7/7 assigned) for no demand-driven reason.
const unassignedCities = country.cities.filter(c => !assignedCityIds.has(c.id));
for (const city of unassignedCities) {
  addInto(flipTruncatedCityIncome, cityIncomeThroughFlip(city.id, hoursToSimulate));
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
const costEvents: CostEvent[] = [...provinceCostEvents];

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
    const { roStep, otherSteps, mobSteps } = shiftedTimingByCity.get(slot.cityId)!;
    if (roStep && roStep.toLevel > 1) costEvents.push({ hour: completionAbsHour, cost: roStep.cost });
    for (const step of otherSteps) costEvents.push({ hour: step.startHour, cost: step.cost });
    for (const m of mobSteps) {
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
// Province mobilisation (e.g. Russia's Commando) — its cost was already correctly
// included in the Resource Balance totals (result.costs.provinceMobilisation /
// provinceUpkeep) but never fed into this walk at all — same class of omission as
// the missing province build costs above (confirmed as the dominant driver of
// Russia's much larger walk-vs-totals gap vs. every other homeland country).
// Mobilisation starts ASAP at hour 0 (confirmed in country-force-projection.ts's
// own comment: "Mobilisation starts ASAP (hour 0) since there's no eco/infra
// dependency gating it") — mercenary_outpost build cost at scenario start,
// mobilisation cost once the outpost completes, upkeep as a flat rate from
// completion to deadline (same flat-rate convention as garrisonHourlyRate below).
const provinceUpkeepHourlyRate = zeroResources();
for (const r of result.provinceMobResults) {
  costEvents.push({ hour: scenarioAbsHour, cost: r.mercenaryOutpostBuildCost });
  costEvents.push({ hour: scenarioAbsHour + r.mercenaryOutpostBuildHours, cost: r.mobilizationCost });
  const completionAbsHour = scenarioAbsHour + r.completionHour;
  const remainingHours = deadlineAbsHour - completionAbsHour;
  if (remainingHours > 0) {
    const upkeep = calculateUpkeepCost(r.unitId, r.level, r.count, remainingHours, catalog, country.country.doctrine);
    for (const res of RESOURCE_KEYS) provinceUpkeepHourlyRate[res] += (upkeep[res] ?? 0) / remainingHours;
  }
}

costEvents.sort((a, b) => a.hour - b.hour);

function unitUpkeepPerHour(absHour: number): Record<Resource, number> {
  const relHour = absHour - scenarioAbsHour;
  if (relHour < 0 || relHour >= hoursToSimulate) return zeroResources();
  const flow = { ...upkeepPerHourByRelHour[relHour] };
  for (const r of result.provinceMobResults) {
    const completionAbsHour = scenarioAbsHour + r.completionHour;
    if (absHour >= completionAbsHour) {
      for (const res of RESOURCE_KEYS) flow[res] += provinceUpkeepHourlyRate[res];
    }
  }
  return flow;
}

function incomeAtHour(absHour: number): Record<Resource, number> {
  const total = zeroResources();
  const relHour = absHour - scenarioAbsHour;
  if (feasible) {
    for (const slot of result.citySlots) {
      const hourly = hourlyProductionByCity.get(`${country.country.id}:${slot.cityId}`) ?? [];
      const shiftedMobSteps = shiftedTimingByCity.get(slot.cityId)?.mobSteps ?? slot.mobSteps;
      const flipAbsHour = shiftedMobSteps.length > 0 ? shiftedMobSteps[0].startAbsHour : deadlineAbsHour;
      const flipRel = flipAbsHour - scenarioAbsHour;
      const idx = relHour < flipRel ? relHour : Math.max(0, Math.round(flipRel) - 1);
      const prod = hourly[idx] ?? {};
      for (const r of RESOURCE_KEYS) total[r] += prod[r] ?? 0;
    }
  }
  // Unassigned cities are never flipped — their raw hourly production applies for
  // the whole window, same reasoning as flipTruncatedCityIncome above.
  for (const city of unassignedCities) {
    const hourly = hourlyProductionByCity.get(`${country.country.id}:${city.id}`) ?? [];
    const prod = hourly[relHour] ?? {};
    for (const r of RESOURCE_KEYS) total[r] += prod[r] ?? 0;
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

// hourlyNetFlow (index 0 = scenarioAbsHour) is exported alongside the rendered
// minima table (as a JSON script tag, see below) so a coalition aggregate can pool
// real per-hour deltas across countries — summing each country's own *minima value*
// is not a true pooled minimum, since countries hit their own worst hour at wildly
// different points in the window (confirmed empirically: some homeland countries
// bottom out on day 2, others on day 29) — only a real hour-aligned sum is correct.
const hourlyNetFlow: Array<Record<Resource, number>> = [];

let eventIdx = 0;
for (let h = scenarioAbsHour; h < deadlineAbsHour; h++) {
  const inc = incomeAtHour(h);
  const uk = unitUpkeepPerHour(h);
  const flow = zeroResources();
  for (const r of RESOURCE_KEYS) {
    flow[r] = inc[r] - uk[r];
    if (h < garrisonDisbandAbsHour) flow[r] -= garrisonHourlyRate[r];
  }
  while (eventIdx < costEvents.length && Math.floor(costEvents[eventIdx].hour) <= h) {
    for (const r of RESOURCE_KEYS) flow[r] -= costEvents[eventIdx].cost[r] ?? 0;
    eventIdx++;
  }
  for (const r of RESOURCE_KEYS) running[r] += flow[r];
  hourlyNetFlow.push(flow);
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
  html += `<p class="label">"[eco]" steps are the unchanged iron eco build; "[eco-backfill]" is RO2/RO3 pulled forward to the earliest free point (manpower bonus from day 1 of being built, so no benefit to delaying it); "[infra]" steps (e.g. air_base, secret_weapons_lab) keep their original force-projection durations/spacing but are shifted later, as a block, whenever the RO2/RO3 backfill would otherwise overlap them — RO2/RO3 genuinely precedes the rest of the chain rather than running in parallel with it. Build Queue (infra) and Mobilisation Queue (units) are genuinely separate parallel queues, shown as separate tables.</p>\n`;

  for (const slot of result.citySlots) {
    const city = country.cities.find(c => c.id === slot.cityId);
    const cityLabel = city ? `${city.name} (${city.resource})` : slot.cityId;

    const { rows: ecoRows, completionAbsHour } = ecoStepsAndCompletion(slot.cityId);
    const buildQueueRows: Array<Record<string, unknown>> = [...ecoRows];

    // Eco already covers RO1 — from-scratch fp chain lists both RO0→1 and RO1→2
    // steps (it doesn't know that), so pick specifically the step that reaches
    // the target roLevel, not just the first recruiting_office step found.
    const { roStep, otherSteps, backfillEndAbsHour, mobSteps } = shiftedTimingByCity.get(slot.cityId)!;

    // Only RO2 is backfilled to the earliest free point (it's the one step with
    // a standalone benefit — manpower bonus — from the moment it's built). Every
    // other required step (air_base, secret_weapons_lab) is shifted later as a
    // block when it would otherwise overlap the backfill — see
    // `shiftedTimingByCity` above.
    if (roStep && roStep.toLevel > 1) {
      buildQueueRows.push({ "#": buildQueueRows.length + 1, at: fmtAbsHour(completionAbsHour), step: `[eco-backfill] recruiting office L${roStep.toLevel}` });
    }
    for (const step of otherSteps) {
      buildQueueRows.push({ "#": buildQueueRows.length + 1, at: fmtAbsHour(step.startHour), step: `[infra] ${step.name}` });
    }

    const flipAbsHour = mobSteps.length > 0 ? mobSteps[0].startAbsHour : backfillEndAbsHour;
    const mobQueueRows = mobSteps.map((m, i) => ({
      "#": i + 1,
      at: fmtAbsHour(m.startAbsHour),
      step: `[mob] ${m.unitId.replaceAll("_", " ")} ×${m.count}`,
    }));

    html += `<h3>${escapeHtml(cityLabel)} — ${escapeHtml(slot.primaryUnitId.replaceAll("_", " "))}, RO L${slot.roLevel}</h3>\n`;
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

  if (unassignedCities.length > 0) {
    html += `<h2>Eco-Only Cities (no military demand)</h2>\n`;
    html += `<p class="label">Not needed by the fold-in for any demand — still run the iron eco heuristic for the full ${plan.truce_days}-day window (never flipped), and their income is now counted in the Resource Balance above.</p>\n`;
    for (const city of unassignedCities) {
      const { rows: ecoRows } = ecoStepsAndCompletion(city.id);
      html += `<h3>${escapeHtml(city.name)} (${escapeHtml(city.resource)})</h3>\n`;
      html += renderTable(ecoRows, ["#", "at", "step"]);
    }
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

// Machine-readable hourly net flow, for a coalition aggregate to pool correctly —
// summing each country's own minima value is NOT a true pooled minimum (countries
// hit their own worst hour at very different points in the window); only a real
// hour-aligned sum across countries is. Index 0 = scenarioAbsHour. Rounded to the
// nearest whole unit — negligible precision loss, keeps the embed compact.
html += `<script type="application/json" id="iron-hourly-net-flow" data-scenario-abs-hour="${scenarioAbsHour}" data-resource-order="${RESOURCE_KEYS.join(",")}">${JSON.stringify(
  hourlyNetFlow.map(flow => RESOURCE_KEYS.map(r => Math.round(flow[r])))
)}</script>\n`;

fs.mkdirSync(path.resolve("tmp"), { recursive: true });
const outHtml = buildHtml(`Iron Build Plan — ${country.country.name}`, html);
const outPath = path.resolve(`tmp/iron-bp-${countryId}.html`);
fs.writeFileSync(outPath, outHtml, "utf8");
console.log(`→ wrote ${outPath}`);
