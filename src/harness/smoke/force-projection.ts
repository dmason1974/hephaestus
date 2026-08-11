import fs from "node:fs";
import path from "node:path";

import type { Resource } from "../../core/constants.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import { durationToHours } from "../../engine/timing/activity-duration.js";
import {
  calculateMobilizationCost,
  calculateUpkeepCost,
  calculateBuildingCost,
  calculateMobilizationDuration,
  sumResourceCosts,
  resourceCostToScalar,
} from "../../engine/optimization/cost-calculator.js";
import type { ResourceCost } from "../../engine/optimization/types.js";
import { simulateUnitResearchTargets, determineMaximumFeasibleLevel } from "../../engine/simulation/unit-research-sim.js";
import { planProvinceMobilization } from "../../engine/simulation/province-mobilization-plan.js";
import { baselineHomelandMoraleOnDay } from "../../engine/economy/morale.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioCoalitionPlan } from "../../scenarios/io/load-coalition-plan.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadMergedUnitCatalogForScenario } from "../../scenarios/io/load-unit-catalog.js";
import type { Demand } from "../../schemas/coalition-force-plan-schema.js";
import {
  computePlanWeights,
  foldInDemands,
  getUnitMinRo,
  infraHeaviness,
  type CityMobSlot,
  type JointCityResult,
  type MoraleAtHour,
  type PlanWeights,
} from "../../engine/optimization/joint-city-optimizer.js";

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

// ── Domain helpers ─────────────────────────────────────────────────────────

function unitMobTimeHours(unitId: string, doctrine: string): number {
  const level1 = catalog.units[unitId]?.levels?.["1"];
  const mobData = level1?.mobilisation?.[doctrine];
  if (!mobData) return 0;
  return durationToHours(mobData.time);
}

function getBatchSize(unitId: string): number {
  return (
    (catalog.units[unitId]?.levels?.["1"] as { batch_size?: number } | undefined)?.batch_size ?? 1
  );
}

/**
 * Returns the building requirements for L1 mobilisation of a unit
 * (buildings only — units are excluded).
 */
function getUnitBuildingRequirements(unitId: string): Map<string, number> {
  const unit = catalog.units[unitId];
  const required = new Map<string, number>();
  if (!unit) return required;
  const level1 = unit.levels["1"];
  if (!level1) return required;
  for (const req of level1.requirements) {
    const match = req.trim().match(/^(.+?)\s+level\s+(\d+)$/i);
    if (!match) continue;
    const id = match[1].trim();
    const lvl = Number(match[2]);
    if (!catalog.units[id] && buildings.buildings[id]) {
      required.set(id, Math.max(required.get(id) ?? 0, lvl));
    }
  }
  return required;
}

function buildingRequirementsCost(unitId: string, cityCount: number): ResourceCost {
  const reqs = getUnitBuildingRequirements(unitId);
  let total: ResourceCost = {};
  for (const [buildingId, requiredLevel] of reqs) {
    if (buildingId === "recruiting_office") continue; // RO cost is tracked via the config generator sweep, not double-counted here
    const perCity = calculateBuildingCost(buildingId, 0, requiredLevel, buildings);
    for (let i = 0; i < cityCount; i++) total = sumResourceCosts(total, perCity);
  }
  return total;
}

function buildingRequirementsScalarPerCity(unitId: string): number {
  const reqs = getUnitBuildingRequirements(unitId);
  let total = 0;
  for (const [buildingId, requiredLevel] of reqs) {
    if (buildingId === "recruiting_office") continue; // see buildingRequirementsCost
    total += resourceCostToScalar(calculateBuildingCost(buildingId, 0, requiredLevel, buildings));
  }
  return total;
}

function getUnitMinRoLevel(unitId: string): number {
  return getUnitBuildingRequirements(unitId).get("recruiting_office") ?? 1;
}

function buildingRequirementsBuildHours(unitId: string): number {
  const reqs = getUnitBuildingRequirements(unitId);
  let total = 0;
  for (const [buildingId, requiredLevel] of reqs) {
    const building = buildings.buildings[buildingId];
    if (!building) continue;
    for (let lvl = 1; lvl <= requiredLevel; lvl++) {
      const levelData = building.levels[String(lvl) as keyof typeof building.levels];
      const bt = (levelData as { build_time?: { days?: number; hours?: number; minutes?: number } } | undefined)?.build_time;
      if (bt) total += durationToHours(bt);
    }
  }
  return total;
}

type InfraStep = { name: string; startHour: number; endHour: number; durH: number };

function buildCityInfraSteps(unitId: string, roLevel: number, startHour: number, weights: PlanWeights): { steps: InfraStep[]; mobOpenHour: number } {
  const steps: InfraStep[] = [];
  let cur = startHour;

  const reqs = getUnitBuildingRequirements(unitId);

  // Compute eco benefit score from building level-1 data and plan weights.
  // Higher score = build earlier. No hardcoded building names.
  //   production_bonus_pct applies to all resources → scale by total weight (all resources benefit)
  //   manpower_bonus_pct applies to manpower only → scale by manpower weight
  //   flat_bonus.manpower is a fixed hourly bonus → scale by manpower weight (normalised per 1000h)
  //   buildings with no income bonus score 0 and sort last
  function ecoScore(buildingId: string): number {
    const l1 = buildings.buildings[buildingId]?.levels["1"];
    if (!l1) return 0;
    const totalWeight = (Object.values(weights) as number[]).reduce((s, w) => s + w, 0);
    const mpWeight = weights.manpower ?? 0;
    return (l1.production_bonus_pct ?? 0) * totalWeight
      + (l1.manpower_bonus_pct ?? 0) * mpWeight
      + (l1.flat_bonus?.manpower ?? 0) * mpWeight / 1000;
  }

  // Merge RO into the requirements map at the target level, then sort descending by eco score
  const allReqs = new Map(reqs);
  if (roLevel > 0) allReqs.set("recruiting_office", roLevel);

  const sorted = [...allReqs.entries()].sort(([a], [b]) => ecoScore(b) - ecoScore(a));

  for (const [bldgId, targetLvl] of sorted) {
    const bldg = buildings.buildings[bldgId];
    if (!bldg) continue;
    for (let lvl = 1; lvl <= targetLvl; lvl++) {
      const levelData = bldg.levels[String(lvl) as keyof typeof bldg.levels];
      const bt = (levelData as { build_time?: { days?: number; hours?: number; minutes?: number } } | undefined)?.build_time;
      if (!bt) continue;
      const dur = Math.ceil(durationToHours(bt));
      steps.push({ name: `${bldgId.replaceAll("_", " ")} L${lvl}`, startHour: cur, endHour: cur + dur, durH: dur });
      cur += dur;
    }
  }

  return { steps, mobOpenHour: cur };
}

// ── Stepped upkeep helpers ────────────────────────────────────────────────

type LevelStep = { absHour: number; level: number };

function getLevelSteps(
  unitId: string,
  segments: Array<{ unitId: string; level: number; endAbsoluteHourExclusive: number }>,
): LevelStep[] {
  return segments
    .filter(s => s.unitId === unitId)
    .map(s => ({ absHour: s.endAbsoluteHourExclusive, level: s.level }))
    .sort((a, b) => a.absHour - b.absHour);
}

/**
 * Computes stepped upkeep for a mob batch.
 * Units auto-upgrade as research levels complete; upkeep steps up accordingly.
 * @param totalUnits  total units produced (entry.count × batchSize)
 * @param unitsPerEvent  units added per mob event (batchSize; 1 for non-batch)
 * @param tPerEvent  time per mob event (entry.tPerUnit)
 */
function computeSteppedUpkeep(
  unitId: string,
  doctrine: string,
  mobStart: number,
  totalUnits: number,
  unitsPerEvent: number,
  tPerEvent: number,
  deadline: number,
  levelSteps: LevelStep[],
): ResourceCost {
  if (totalUnits <= 0 || tPerEvent <= 0) return {};

  const numEvents = Math.ceil(totalUnits / unitsPerEvent);
  const eventSet = new Set<number>([deadline]);
  for (let k = 1; k <= numEvents; k++) {
    const t = mobStart + k * tPerEvent;
    if (t < deadline) eventSet.add(t);
  }
  for (const step of levelSteps) {
    if (step.absHour > mobStart && step.absHour < deadline) eventSet.add(step.absHour);
  }
  const events = [...eventSet].sort((a, b) => a - b);

  // Highest research level completed at or before mobStart
  let level = 1;
  for (const step of levelSteps) {
    if (step.absHour <= mobStart && step.level > level) level = step.level;
  }
  const levelAtEvent = new Map<number, number>();
  for (const step of levelSteps) {
    const prev = levelAtEvent.get(step.absHour) ?? 0;
    if (step.level > prev) levelAtEvent.set(step.absHour, step.level);
  }

  let total: ResourceCost = {};
  let prevT = mobStart;

  for (const t of events) {
    const dt = t - prevT;
    if (dt > 0) {
      // countAlive = units that have completed mob by prevT
      const eventsCompleted = Math.min(numEvents, Math.floor((prevT - mobStart) / tPerEvent));
      const countAlive = eventsCompleted * unitsPerEvent;
      if (countAlive > 0) {
        try {
          total = sumResourceCosts(total, calculateUpkeepCost(unitId, level, countAlive, dt, catalog, doctrine));
        } catch {
          // missing doctrine/level data — skip interval
        }
      }
    }
    const newLevel = levelAtEvent.get(t);
    if (newLevel !== undefined && newLevel > level) level = newLevel;
    prevT = t;
  }

  return total;
}

// ── Per-country analysis ───────────────────────────────────────────────────

function analyseCountry(countryId: string): string {
  const country = loadScenarioCountry(scenarioId, countryId);
  const doctrine = country.country.doctrine;
  const countryPlan = plan.countries[countryId];

  if (!countryPlan?.demands?.length) {
    return `<p class="skipped">No demands defined for ${countryId}.</p>`;
  }

  const provinceDemands: Demand[] = [];
  const launcherDemands: Demand[] = [];
  const activeDemands: Demand[] = [];

  for (const demand of countryPlan.demands) {
    if (demand.mobilisation_source === "province") {
      provinceDemands.push(demand);
    } else if (unitMobTimeHours(demand.unitId, doctrine) === 0) {
      launcherDemands.push(demand);
    } else {
      activeDemands.push(demand);
    }
  }

  if (activeDemands.length === 0) {
    return `<p class="skipped">No city-mobilised demands for ${countryId}.</p>`;
  }

  type DemandResult = { demand: Demand; batchSize: number; effectiveCount: number };
  const demandResults: DemandResult[] = activeDemands.map(demand => {
    const batchSize = getBatchSize(demand.unitId);
    return { demand, batchSize, effectiveCount: Math.ceil(demand.count / batchSize) };
  });

  // ── Joint demand optimization — fold-in algorithm ─────────────────────────
  // Demands are sorted heaviest-infra-first; each subsequent demand folds in
  // to existing cities when cheaper than opening new ones (Smith's rule mob
  // ordering within each city). Plan-derived weights make cost comparisons
  // reflect actual resource scarcity.

  const countryAllCityIds = country.cities.map(c => c.id);
  const isOccupied = (countryPlan.status ?? "homeland") === "occupied";
  const moraleAtAbsHour: MoraleAtHour = (absHour) => {
    const day = Math.floor(absHour / 24) + 1;
    // TODO: use captured morale curve when an occupied morale function is available
    return isOccupied ? 50 : baselineHomelandMoraleOnDay(day);
  };

  const planWeights: PlanWeights = computePlanWeights(
    activeDemands.map(d => ({
      unitId: d.unitId,
      effectiveCount: Math.ceil(d.count / getBatchSize(d.unitId)),
    })),
    catalog,
    doctrine,
    plan.truce_days,
  );

  const foldResult: JointCityResult = foldInDemands(
    activeDemands.map(d => ({
      unitId: d.unitId,
      effectiveCount: Math.ceil(d.count / getBatchSize(d.unitId)),
    })),
    countryAllCityIds,
    catalog,
    buildings,
    doctrine,
    scenarioAbsHour,
    deadlineAbsHour,
    planWeights,
    maxRoLevel,
    moraleAtAbsHour,
  );

  // ── Combined JIT research plan (L1 constraints from fold-in mob schedule) ──
  const researchTargets: Record<string, number> = {};
  const latestCompletionByUnitLevel: Record<string, number> = {};
  const unitDemandCounts: Record<string, number> = {};

  for (const { demand, effectiveCount } of demandResults) {
    const uid = demand.unitId;
    unitDemandCounts[uid] = effectiveCount;
    researchTargets[uid] = determineMaximumFeasibleLevel(
      catalog, uid,
      { ...scenario, truce_length_days: plan.truce_days },
      { deadlineAbsoluteHour: deadlineAbsHour, doctrine, slots: 1 },
    ).maxLevel;
  }

  // For each city slot, derive the JIT mob start for each entry and update
  // the L1 constraint: L1 must complete before its mob window opens.
  for (const slot of foldResult.citySlots) {
    let cumBefore = 0;
    for (const entry of slot.mobQueue) {
      const totalFromHere = slot.usedHours - cumBefore;
      const jitMobStart = deadlineAbsHour - totalFromHere;
      const actualMobStart = Math.max(slot.infraOpenHour + cumBefore, jitMobStart);
      const key = `${entry.unitId}:1`;
      const cur = latestCompletionByUnitLevel[key] ?? Infinity;
      if (actualMobStart < cur) latestCompletionByUnitLevel[key] = actualMobStart;
      cumBefore += entry.totalMobHours;
    }
  }

  const combinedResearch = simulateUnitResearchTargets(
    catalog,
    researchTargets,
    { ...scenario, truce_length_days: plan.truce_days },
    { enableJitScheduling: true, doctrine, latestCompletionByUnitLevel, unitDemandCounts },
  );

  // ── Build HTML ───────────────────────────────────────────────────────────
  const countryName = country.country.name;
  const cityNameMap = new Map<string, string>(country.cities.map(c => [c.id, c.name]));

  let html = `<h1>${escapeHtml(countryName)}</h1>\n`;
  html += `<p class="label">Doctrine: ${escapeHtml(doctrine)} · Status: ${escapeHtml(countryPlan.status ?? "homeland")} `;
  html += `· Deadline: ${fmtAbsHour(deadlineAbsHour)} (${plan.truce_days} days) · morale ${moraleAtAbsHour(scenarioAbsHour)}%→${moraleAtAbsHour(deadlineAbsHour)}%</p>\n`;

  // Section 1: Combined JIT research plan
  html += `<h2>Research Plan</h2>\n`;
  html += `<p class="label">L1 JIT (ends at deadline − mob window); L2+ JIT from deadline. Priority: impact × demand count.</p>\n`;
  const researchRows = combinedResearch.segments
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

  if (foldResult.citySlots.length === 0) {
    html += `<p class="infeasible">INFEASIBLE — fold-in found no feasible city allocation.</p>\n`;
  }

  for (const slot of foldResult.citySlots) {
    const cName = cityNameMap.get(slot.cityId) ?? slot.cityId;
    const queueSummary = slot.mobQueue.map(e =>
      `${e.unitId.replaceAll("_", " ")} ×${e.count}`
    ).join(", ");
    html += `<h3>${escapeHtml(cName)} — RO L${slot.roLevel}</h3>\n`;
    html += `<p class="label">Infra: ${escapeHtml(slot.primaryUnitId.replaceAll("_", " "))} requirements · Mob queue: ${escapeHtml(queueSummary)}</p>\n`;

    const primaryUnitId = slot.primaryUnitId;

    // JIT infra start: work backwards from when the first mob entry is needed
    const firstEntry = slot.mobQueue[0];
    const firstJitMobStart = deadlineAbsHour - slot.usedHours;
    const firstL1EndForJit = combinedResearch.segments.find(
      s => s.unitId === firstEntry?.unitId && s.level === 1,
    )?.endAbsoluteHourExclusive ?? deadlineAbsHour;
    const firstMobStart = Math.max(slot.infraOpenHour, firstJitMobStart, firstL1EndForJit);
    const infraBuildHours = slot.infraOpenHour - scenarioAbsHour;
    // This is the real flip point: the latest hour this city can still be running
    // eco builds before it must switch to military infra to hit the deadline.
    // (slot.flipPointHour is a simpler, research-unaware version of the same idea —
    // this one additionally accounts for L1 research completion timing.)
    const jitInfraStart = Math.max(scenarioAbsHour, firstMobStart - infraBuildHours);
    html += `<p class="label"><strong>Flip point: ${fmtAbsHour(jitInfraStart)}</strong> — eco until then, military infra after.</p>\n`;

    const { steps, mobOpenHour: infraDoneHour } = buildCityInfraSteps(primaryUnitId, slot.roLevel, jitInfraStart, planWeights);
    const stepRows: Array<Record<string, unknown>> = steps.map((s, i) => ({
      "#": i + 1, step: s.name,
      start: fmtAbsHour(s.startHour), complete: fmtAbsHour(s.endHour), dur: `${s.durH}h`,
    }));

    // Compute JIT mob start for each queue entry (working backwards from deadline)
    // Actual mob start = max(infraDone + cumulative preceding mob, jitMobStart)
    let cumBefore = 0;
    let stepNum = steps.length + 1;
    for (const entry of slot.mobQueue) {
      const totalFromHere = slot.usedHours - cumBefore;
      const jitMobStart = deadlineAbsHour - totalFromHere;
      const l1End = combinedResearch.segments.find(
        s => s.unitId === entry.unitId && s.level === 1,
      )?.endAbsoluteHourExclusive ?? deadlineAbsHour;
      const mobStart = Math.max(infraDoneHour + cumBefore, jitMobStart, l1End);
      const mobEnd = mobStart + entry.totalMobHours;

      stepRows.push({
        "#": stepNum++,
        step: `${entry.unitId.replaceAll("_", " ")} mob ×${entry.count}`,
        start: fmtAbsHour(mobStart),
        complete: fmtAbsHour(mobEnd),
        dur: `${Math.round(entry.totalMobHours)}h`,
      });
      cumBefore += entry.totalMobHours;
    }
    html += renderTable(stepRows, ["#", "step", "start", "complete", "dur"]);
  }

  // Section 3: Mobilisation Cost Summary — aggregate across all demands
  html += `<h2>Mobilisation Cost Summary</h2>\n`;

  const demandLabels = demandResults.map(({ demand, batchSize, effectiveCount }) => {
    const batchNote = batchSize > 1 ? ` (${effectiveCount} mob events)` : "";
    return `${demand.unitId.replaceAll("_", " ")} ×${demand.count}${batchNote}`;
  });
  html += `<p class="label">${escapeHtml(demandLabels.join(" · "))}</p>\n`;

  let aggInfraRo: ResourceCost = {};
  let aggInfraBldg: ResourceCost = {};
  let aggMob: ResourceCost = {};
  let aggUpkeep: ResourceCost = {};

  for (const { demand, batchSize } of demandResults) {
    const uid = demand.unitId;
    const mySlots = foldResult.citySlots.filter(s => s.mobQueue.some(e => e.unitId === uid));
    if (mySlots.length === 0) continue;

    // Infra: primary slots only
    for (const slot of mySlots) {
      if (slot.primaryUnitId !== uid) continue;
      aggInfraRo = sumResourceCosts(aggInfraRo, calculateBuildingCost("recruiting_office", 0, slot.roLevel, buildings));
      aggInfraBldg = sumResourceCosts(aggInfraBldg, buildingRequirementsCost(uid, 1));
    }

    // Mob cost (at L1; entry.count = mob events)
    const totalMobEvents = mySlots.reduce((s, slot) => {
      const e = slot.mobQueue.find(e => e.unitId === uid);
      return s + (e?.count ?? 0);
    }, 0);
    aggMob = sumResourceCosts(aggMob, calculateMobilizationCost(uid, 1, totalMobEvents, catalog, doctrine));

    // Stepped upkeep
    const levelSteps = getLevelSteps(uid, combinedResearch.segments);
    for (const slot of mySlots) {
      let cumBefore = 0;
      for (const entry of slot.mobQueue) {
        const totalFromHere = slot.usedHours - cumBefore;
        const jitMobStart = deadlineAbsHour - totalFromHere;
        const l1End = combinedResearch.segments.find(
          s => s.unitId === entry.unitId && s.level === 1,
        )?.endAbsoluteHourExclusive ?? deadlineAbsHour;
        const mobStart = Math.max(slot.infraOpenHour + cumBefore, jitMobStart, l1End);

        if (entry.unitId === uid) {
          aggUpkeep = sumResourceCosts(aggUpkeep, computeSteppedUpkeep(
            uid, doctrine, mobStart,
            entry.count * batchSize,  // total alive units
            batchSize,                 // units per mob event
            entry.tPerUnit,
            deadlineAbsHour,
            levelSteps,
          ));
        }
        cumBefore += entry.totalMobHours;
      }
    }
  }

  // ── Province-mobilised demands (commando etc.) ────────────────────────────
  // Capacity is one mobilisation slot per province; mercenary_outpost can only
  // be built in a province (never a city) and its speed bonus applies country-
  // wide once built in any single one. Mobilisation starts ASAP (hour 0) since
  // there's no eco/infra dependency gating it.
  const provinceMobResults = provinceDemands.map(demand => planProvinceMobilization({
    unitId: demand.unitId,
    level: 1,
    count: demand.count,
    provinceCount: country.provinces.total,
    unitCatalog: catalog,
    buildings,
    doctrine,
  }));
  let aggProvinceMob: ResourceCost = {};
  let aggProvinceUpkeep: ResourceCost = {};
  for (const result of provinceMobResults) {
    aggProvinceMob = sumResourceCosts(aggProvinceMob, result.totalCost);
    const remainingHours = deadlineAbsHour - (scenarioAbsHour + result.completionHour);
    if (remainingHours > 0) {
      aggProvinceUpkeep = sumResourceCosts(
        aggProvinceUpkeep,
        calculateUpkeepCost(result.unitId, result.level, result.count, remainingHours, catalog, doctrine)
      );
    }
  }

  if (foldResult.citySlots.length === 0 && provinceMobResults.length === 0) {
    html += `<p class="infeasible">INFEASIBLE — no cities allocated.</p>\n`;
  } else {
    const aggTotal = sumResourceCosts(aggInfraRo, aggInfraBldg, aggMob, aggUpkeep, aggProvinceMob, aggProvinceUpkeep);
    html += `<table>
      ${resourceTableHeader()}
      ${resourceRow("Infra (RO)", aggInfraRo)}
      ${resourceRow("Infra (buildings)", aggInfraBldg)}
      ${resourceRow("Mobilisation", aggMob)}
      ${resourceRow("Upkeep (stepped)", aggUpkeep)}
      ${resourceRow("Province mob + mercenary_outpost", aggProvinceMob)}
      ${resourceRow("Province upkeep (flat)", aggProvinceUpkeep)}
      ${resourceRow("Total", aggTotal)}
    </table>\n`;
  }

  if (provinceMobResults.length > 0) {
    html += `<h2>Province Mobilisation Detail</h2>\n`;
    html += `<ul>${provinceMobResults.map(r =>
      `<li>${escapeHtml(r.unitId)} × ${r.count} — mercenary_outpost L${r.mercenaryOutpostRequiredLevel} ` +
      `(${r.mercenaryOutpostBuildHours}h) then mobilise (${r.mobilizationDurationHours}h), ` +
      `completes hour ${r.completionHour}, capacity ${r.provinceCount} provinces</li>`
    ).join("")}</ul>\n`;
  }

  // Section 5: Skipped demands
  const skipped = [
    ...launcherDemands.map(d => `${d.unitId} × ${d.count} — launcher platform (zero mob cost)`),
  ];
  if (skipped.length > 0) {
    html += `<h2>Skipped Demands</h2>\n`;
    html += `<ul>${skipped.map(s => `<li class="skipped">${escapeHtml(s)}</li>`).join("")}</ul>\n`;
  }

  return html;
}

// ── Main ───────────────────────────────────────────────────────────────────

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
