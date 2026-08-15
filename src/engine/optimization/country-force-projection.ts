import type { BuildingsFile } from "../../schemas/building-schema.js";
import type { Country } from "../../schemas/country-schema.js";
import type { ScenarioFile } from "../../schemas/scenario-schema.js";
import type { UnitCatalog } from "../../schemas/unit-schema.js";
import type { Demand } from "../../schemas/coalition-force-plan-schema.js";
import { durationToHours } from "../timing/activity-duration.js";
import {
  calculateMobilizationCost,
  calculateUpkeepCost,
  calculateBuildingCost,
  sumResourceCosts,
} from "./cost-calculator.js";
import type { ResourceCost } from "./types.js";
import { simulateUnitResearchTargets, determineMaximumFeasibleLevel, computeAsapResearchCompletions } from "../simulation/unit-research-sim.js";
import type { UnitResearchSegment, ResearchAsapPin } from "../simulation/unit-research-sim.js";
import { planProvinceMobilization } from "../simulation/province-mobilization-plan.js";
import type { ProvinceMobilizationPlan } from "../simulation/province-mobilization-plan.js";
import { baselineHomelandMoraleOnDay } from "../economy/morale.js";
import { computeFlipPoint, computeEcoBackfill, withBackfilledLevels } from "../eco/flip-point-solver.js";
import type { EcoBackfillStep } from "../eco/flip-point-solver.js";
import type { CityEcoResult } from "../eco/city-eco-beam.js";
import {
  computePlanWeights,
  foldInDemands,
  type CityMobSlot,
  type MobQueueEntry,
  type MoraleAtHour,
  type PlanWeights,
} from "./joint-city-optimizer.js";

// ── Domain helpers (moved from harness/smoke/force-projection.ts, unchanged logic) ──

/**
 * Whether the catalog has any mobilisation data at all for this unit+doctrine.
 * Distinct from "genuinely zero mob time" (a real launcher platform) — this is
 * "we don't know the mob time because the doctrine data is missing" (a data gap).
 * Conflating the two used to make classifyDemands silently drop units with missing
 * doctrine data (misclassifying them as launcher platforms) instead of surfacing
 * the gap.
 */
function hasMobilisationData(unitId: string, doctrine: string, catalog: UnitCatalog): boolean {
  return !!catalog.units[unitId]?.levels?.["1"]?.mobilisation?.[doctrine];
}

function unitMobTimeHours(unitId: string, doctrine: string, catalog: UnitCatalog): number {
  const level1 = catalog.units[unitId]?.levels?.["1"];
  const mobData = level1?.mobilisation?.[doctrine];
  if (!mobData) return 0;
  return durationToHours(mobData.time);
}

export function getBatchSize(unitId: string, catalog: UnitCatalog): number {
  return (
    (catalog.units[unitId]?.levels?.["1"] as { batch_size?: number } | undefined)?.batch_size ?? 1
  );
}

/**
 * Returns the building requirements for L1 mobilisation of a unit
 * (buildings only — units are excluded).
 */
export function getUnitBuildingRequirements(unitId: string, catalog: UnitCatalog, buildings: BuildingsFile): Map<string, number> {
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

function buildingRequirementsCost(unitId: string, cityCount: number, catalog: UnitCatalog, buildings: BuildingsFile): ResourceCost {
  const reqs = getUnitBuildingRequirements(unitId, catalog, buildings);
  let total: ResourceCost = {};
  for (const [buildingId, requiredLevel] of reqs) {
    if (buildingId === "recruiting_office") continue; // RO cost is tracked via the config generator sweep, not double-counted here
    const perCity = calculateBuildingCost(buildingId, 0, requiredLevel, buildings);
    for (let i = 0; i < cityCount; i++) total = sumResourceCosts(total, perCity);
  }
  return total;
}

export type ClassifiedDemands = {
  provinceDemands: Demand[];
  launcherDemands: Demand[];
  activeDemands: Demand[];
  /** Units with NO mobilisation data at all for this country's doctrine — a
   *  catalog data gap, not a real demand classification. Excluded from every
   *  other bucket so they're never silently costed as zero. */
  missingDataDemands: Demand[];
};

/**
 * Splits demands into province-mobilised, launcher-platform (genuinely zero mob
 * time), active (city-mobilised), and missing-doctrine-data buckets. Exported so
 * callers (e.g. the resource-projection harness) can compute `activeDemands` for
 * `computePlanWeights` before Unit 2 runs.
 */
export function classifyDemands(demands: Demand[], doctrine: string, catalog: UnitCatalog): ClassifiedDemands {
  const provinceDemands: Demand[] = [];
  const launcherDemands: Demand[] = [];
  const activeDemands: Demand[] = [];
  const missingDataDemands: Demand[] = [];

  for (const demand of demands) {
    if (demand.mobilisation_source === "province") {
      provinceDemands.push(demand);
    } else if (!hasMobilisationData(demand.unitId, doctrine, catalog)) {
      missingDataDemands.push(demand);
    } else if (unitMobTimeHours(demand.unitId, doctrine, catalog) === 0) {
      launcherDemands.push(demand);
    } else {
      activeDemands.push(demand);
    }
  }

  return { provinceDemands, launcherDemands, activeDemands, missingDataDemands };
}

export type InfraStep = {
  name: string;
  buildingId: string;
  fromLevel: number;
  toLevel: number;
  startHour: number;
  endHour: number;
  durH: number;
  cost: ResourceCost;
};

/**
 * Building build order for a city's infra chain: recruiting_office is mandatory
 * first (cheap, and needed for its manpower bonus from day 1 — settled UAT rule),
 * everything else sorted descending by eco benefit score.
 *   production_bonus_pct applies to all resources → scale by total weight (all resources benefit)
 *   manpower_bonus_pct applies to manpower only → scale by manpower weight
 *   flat_bonus.manpower is a fixed hourly bonus → scale by manpower weight (normalised per 1000h)
 *   buildings with no income bonus score 0 and sort last
 */
function makeInfraOrderBuildings(weights: PlanWeights, buildings: BuildingsFile): (ids: string[]) => string[] {
  function ecoScore(buildingId: string): number {
    const l1 = buildings.buildings[buildingId]?.levels["1"];
    if (!l1) return 0;
    const totalWeight = (Object.values(weights) as number[]).reduce((s, w) => s + w, 0);
    const mpWeight = weights.manpower ?? 0;
    return (l1.production_bonus_pct ?? 0) * totalWeight
      + (l1.manpower_bonus_pct ?? 0) * mpWeight
      + (l1.flat_bonus?.manpower ?? 0) * mpWeight / 1000;
  }
  return (ids: string[]) => [
    ...ids.filter(id => id === "recruiting_office"),
    ...ids.filter(id => id !== "recruiting_office").sort((a, b) => ecoScore(b) - ecoScore(a)),
  ];
}

/**
 * A city qualifies for the dead-window build order (below) when its mob queue
 * pairs a long-pole unit (e.g. stealth_air_superiority_fighter, needing
 * air_base L5 + secret_weapons_lab) with at least one genuine filler whose own
 * requirements are a STRICT subset (e.g. conventional_warhead needs only
 * secret_weapons_lab + arms_industry — no air_base at all; uav needs only
 * air_base L1 + arms_industry L1; awacs needs only air_base L4 + arms_industry
 * L1). Detected once city assignment + mob queue composition is known, before
 * the infra chain is built — every other slot (no such relationship) keeps
 * `makeInfraOrderBuildings` exactly as today.
 */
export function isDeadWindowSlot(mobQueue: MobQueueEntry[], catalog: UnitCatalog, buildings: BuildingsFile): boolean {
  const unitIds = [...new Set(mobQueue.map(e => e.unitId))];
  if (unitIds.length < 2) return false;
  const reqsByUnit = new Map(unitIds.map(id => [id, getUnitBuildingRequirements(id, catalog, buildings)]));
  for (const a of unitIds) {
    for (const b of unitIds) {
      if (a === b) continue;
      if (isStrictRequirementSubset(reqsByUnit.get(a)!, reqsByUnit.get(b)!)) return true;
    }
  }
  return false;
}

function isStrictRequirementSubset(small: Map<string, number>, big: Map<string, number>): boolean {
  for (const [bldgId, lvl] of small) {
    if ((big.get(bldgId) ?? 0) < lvl) return false;
  }
  if (small.size !== big.size) return true;
  for (const [bldgId, lvl] of small) {
    if (big.get(bldgId) !== lvl) return true;
  }
  return false; // identical requirement sets — not a genuine filler relationship
}

/**
 * Dead-window build order (scoped to qualifying slots only, per `isDeadWindowSlot`
 * — NOT a global replacement of `makeInfraOrderBuildings`, per this session's
 * decision; see CLAUDE.md for the note on reconsidering a global default later).
 *
 * `secret_weapons_lab` is ecoScore-ordered along with `arms_industry`/`air_base`
 * (not front-loaded ahead of them): it has no `production_bonus_pct`, so it always
 * sorts after both, which have real eco value while being built. An earlier
 * version of this function front-loaded `secret_weapons_lab` specifically to
 * unlock `conventional_warhead`'s mobilisation-eligibility as early as possible —
 * but that only matters when a filler sharing the queue actually needs
 * `secret_weapons_lab`, and per the user's direction this is deliberately *not*
 * conditioned on that: AI (arms_industry) levels are currently set
 * deterministically per city (not derived per-filler), and warhead-producing
 * cities have a low deterministic AI target anyway (fuel: L1 only; components:
 * L1→L2 — see `AI_TARGET_BY_RESOURCE` in `iron-heuristic.ts`), so deferring
 * `secret_weapons_lab` until after the eco-benefit buildings costs little there
 * even though warhead does need it. Applies uniformly regardless of whether a
 * city is SASF-producing or warhead-producing.
 * `recruiting_office` moves to the END instead of the front.
 *
 * Why moving RO to the end doesn't delay its day-1 manpower benefit: RO L1 is
 * already forced as the very first ECO-PHASE action (`forceRO` in
 * `city-eco-beam.ts`, unconditional whenever resourceWeights is supplied) —
 * entirely upstream of this ordering function. By the time this function runs, RO
 * is normally already credited to L1 (see `buildCityInfraStepsFromEco`'s
 * crediting), so "RO last" here almost always only defers L2+, not L1 — matching
 * "RO1 first, RO2+ last" without needing to split one building's level range into
 * two ordering positions (which `orderBuildings`'s ids-permutation shape can't
 * express).
 *
 * This ordering governs BOTH the eco-backfill pass and the post-flip remaining
 * chain — `buildCityInfraStepsFromEco` feeds the same `orderBuildings` into both
 * `computeEcoBackfill` and `computeFlipPoint`/`buildRemainingChain` (an earlier
 * version of this comment claimed backfill was unaffected; it wasn't — see
 * `computeEcoBackfill`'s "skip, don't abort" behavior).
 * Known gap: the formula-based fallback path (`buildCityInfraSteps`, used only
 * when a city has no Unit 1.5 eco result) has no eco-phase RO credit, so in that
 * fallback specifically RO L1 would also be deferred — an accepted, minor
 * limitation since the real harness always supplies eco results.
 */
function makeDeadWindowOrderBuildings(weights: PlanWeights, buildings: BuildingsFile): (ids: string[]) => string[] {
  function ecoScore(buildingId: string): number {
    const l1 = buildings.buildings[buildingId]?.levels["1"];
    if (!l1) return 0;
    const totalWeight = (Object.values(weights) as number[]).reduce((s, w) => s + w, 0);
    const mpWeight = weights.manpower ?? 0;
    return (l1.production_bonus_pct ?? 0) * totalWeight
      + (l1.manpower_bonus_pct ?? 0) * mpWeight
      + (l1.flat_bonus?.manpower ?? 0) * mpWeight / 1000;
  }
  return (ids: string[]) => [
    ...ids.filter(id => id !== "recruiting_office").sort((a, b) => ecoScore(b) - ecoScore(a)),
    ...ids.filter(id => id === "recruiting_office"),
  ];
}

function requiredLevelsForUnit(
  unitId: string,
  roLevel: number,
  catalog: UnitCatalog,
  buildings: BuildingsFile,
  extraRequiredLevels?: Partial<Record<string, number>>,
): Record<string, number> {
  const reqs = getUnitBuildingRequirements(unitId, catalog, buildings);
  const allReqs = new Map(reqs);
  if (roLevel > 0) allReqs.set("recruiting_office", roLevel);
  for (const [bldgId, lvl] of Object.entries(extraRequiredLevels ?? {})) {
    if (lvl !== undefined) allReqs.set(bldgId, Math.max(allReqs.get(bldgId) ?? 0, lvl));
  }
  return Object.fromEntries(allReqs);
}

/** Formula-based infra chain: builds every required level from scratch, starting at `startHour`. */
function buildCityInfraSteps(
  unitId: string,
  roLevel: number,
  startHour: number,
  weights: PlanWeights,
  catalog: UnitCatalog,
  buildings: BuildingsFile,
  orderBuildingsOverride?: (ids: string[]) => string[],
  extraRequiredLevels?: Partial<Record<string, number>>,
): { steps: InfraStep[]; mobOpenHour: number } {
  const steps: InfraStep[] = [];
  let cur = startHour;

  const requiredLevels = requiredLevelsForUnit(unitId, roLevel, catalog, buildings, extraRequiredLevels);
  const orderBuildings = orderBuildingsOverride ?? makeInfraOrderBuildings(weights, buildings);
  const orderedIds = orderBuildings(Object.keys(requiredLevels));

  for (const bldgId of orderedIds) {
    const targetLvl = requiredLevels[bldgId];
    const bldg = buildings.buildings[bldgId];
    if (!bldg) continue;
    for (let lvl = 1; lvl <= targetLvl; lvl++) {
      const levelData = bldg.levels[String(lvl) as keyof typeof bldg.levels];
      const bt = (levelData as { build_time?: { days?: number; hours?: number; minutes?: number } } | undefined)?.build_time;
      if (!bt) continue;
      const dur = Math.ceil(durationToHours(bt));
      const cost = calculateBuildingCost(bldgId, lvl - 1, lvl, buildings);
      steps.push({ name: `${bldgId.replaceAll("_", " ")} L${lvl}`, buildingId: bldgId, fromLevel: lvl - 1, toLevel: lvl, startHour: cur, endHour: cur + dur, durH: dur, cost });
      cur += dur;
    }
  }

  return { steps, mobOpenHour: cur };
}

const MAX_BACKFILL_ITERATIONS = 3;

/**
 * Eco-aware infra chain: credits building levels the city's Unit 1.5 "actual eco
 * build" already completed, and iteratively re-derives the flip point (via
 * `computeFlipPoint`'s convergence loop, repurposed with `mobilisationWindowHours: 0`
 * and `deadlineAbsHour: firstMobStart` to solve "latest flip such that flip +
 * eco-credited-remaining-chain = firstMobStart"). Fixes the double-build bug where
 * the formula-based path above rebuilds buildings the eco phase already built.
 *
 * Also backfills guaranteed-but-unscored required levels (e.g. recruiting_office L2,
 * arms_industry L1) into any idle window between the eco phase's last organic build
 * and the flip point (see flip-point-solver.ts's `computeEcoBackfill`). Backfilling
 * can only shrink the remaining chain, so the flip point only ever moves later or
 * stays put — this small convergence loop just lets that settle (typically 1-2
 * rounds): compute a flip estimate, backfill up to that estimate, re-derive flip
 * against the augmented eco result, repeat until stable.
 */
function buildCityInfraStepsFromEco(
  unitId: string,
  roLevel: number,
  firstMobStart: number,
  scenarioAbsHour: number,
  weights: PlanWeights,
  catalog: UnitCatalog,
  buildings: BuildingsFile,
  ecoResult: CityEcoResult,
  orderBuildingsOverride?: (ids: string[]) => string[],
  extraRequiredLevels?: Partial<Record<string, number>>,
): { steps: InfraStep[]; ecoBackfillSteps: InfraStep[]; mobOpenHour: number; flipPointAbsHour: number } {
  const requiredLevels = requiredLevelsForUnit(unitId, roLevel, catalog, buildings, extraRequiredLevels);
  const orderBuildings = orderBuildingsOverride ?? makeInfraOrderBuildings(weights, buildings);

  let flipEstimate = computeFlipPoint(ecoResult, requiredLevels, 0, firstMobStart, scenarioAbsHour, buildings, 4, orderBuildings).flipPointAbsHour;
  let backfill: EcoBackfillStep[] = [];
  let augmented = ecoResult;

  for (let i = 0; i < MAX_BACKFILL_ITERATIONS; i++) {
    const windowEnd = Math.max(ecoResult.lastEcoBuildCompletionAbsHour, flipEstimate);
    const newBackfill = computeEcoBackfill(ecoResult, requiredLevels, windowEnd, buildings, orderBuildings);
    augmented = withBackfilledLevels(ecoResult, newBackfill);
    const newFlip = computeFlipPoint(augmented, requiredLevels, 0, firstMobStart, scenarioAbsHour, buildings, 4, orderBuildings).flipPointAbsHour;
    backfill = newBackfill;
    const converged = Math.abs(newFlip - flipEstimate) < 0.5;
    flipEstimate = newFlip;
    if (converged) break;
  }

  const result = computeFlipPoint(augmented, requiredLevels, 0, firstMobStart, scenarioAbsHour, buildings, 4, orderBuildings);
  const flipPointAbsHour = Math.max(scenarioAbsHour, result.flipPointAbsHour);

  const ecoBackfillSteps: InfraStep[] = backfill
    .filter(step => step.endHour <= flipPointAbsHour) // defensive; provably always true (backfilling can only shrink remainingChain, never grow it)
    .map(step => ({
      name: `${step.buildingId.replaceAll("_", " ")} L${step.toLevel}`,
      buildingId: step.buildingId,
      fromLevel: step.fromLevel,
      toLevel: step.toLevel,
      startHour: step.startHour,
      endHour: step.endHour,
      durH: step.buildTimeHours,
      cost: calculateBuildingCost(step.buildingId, step.fromLevel, step.toLevel, buildings),
    }));

  const steps: InfraStep[] = [];
  let cur = flipPointAbsHour;
  for (const step of result.remainingChain) {
    const cost = calculateBuildingCost(step.buildingId, step.fromLevel, step.toLevel, buildings);
    steps.push({ name: `${step.buildingId.replaceAll("_", " ")} L${step.toLevel}`, buildingId: step.buildingId, fromLevel: step.fromLevel, toLevel: step.toLevel, startHour: cur, endHour: cur + step.buildTimeHours, durH: step.buildTimeHours, cost });
    cur += step.buildTimeHours;
  }

  return { steps, ecoBackfillSteps, mobOpenHour: cur, flipPointAbsHour };
}

// ── Stepped upkeep helpers ────────────────────────────────────────────────

export type LevelStep = { absHour: number; level: number };

export function getLevelSteps(
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
export function computeSteppedUpkeep(
  unitId: string,
  doctrine: string,
  mobStart: number,
  totalUnits: number,
  unitsPerEvent: number,
  tPerEvent: number,
  deadline: number,
  levelSteps: LevelStep[],
  catalog: UnitCatalog,
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

// ── Dead-window mob-queue scheduling ────────────────────────────────────────

/**
 * Sum of build times for a unit's OWN required levels, built from scratch —
 * ignores the primary unit's chain and any eco credit entirely. Used as an
 * early, safe, primary-unit-independent estimate of a dead-window filler's own
 * readiness, before the actual infra chain (which credits eco progress and
 * respects the dead-window order) is known — see its call site's comment.
 */
function sumRequiredBuildHoursFromScratch(unitId: string, catalog: UnitCatalog, buildings: BuildingsFile): number {
  const reqs = getUnitBuildingRequirements(unitId, catalog, buildings);
  let total = 0;
  for (const [bldgId, targetLvl] of reqs) {
    const bldg = buildings.buildings[bldgId];
    if (!bldg) continue;
    for (let lvl = 1; lvl <= targetLvl; lvl++) {
      const levelData = bldg.levels[String(lvl) as keyof typeof bldg.levels];
      const bt = (levelData as { build_time?: { days?: number; hours?: number; minutes?: number } } | undefined)?.build_time;
      if (bt) total += Math.ceil(durationToHours(bt));
    }
  }
  return total;
}

/**
 * The absolute hour a given unit's OWN required levels are all satisfied in this
 * city's build timeline — independent of the primary/long-pole unit's full chain.
 * A required level found in `ecoBackfillSteps`/`infraSteps` uses that step's real
 * completion hour; a level not found there (already satisfied by eco-organic
 * builds or starting levels before the flip point) falls back to `flipPointAbsHour`
 * as a safe upper bound (it's provably done by then, possibly earlier — a minor,
 * conservative approximation, not a correctness bug: it can only ever delay a
 * filler's computed readiness, never claim it's ready before it truly is).
 */
function computeReadinessHour(
  unitId: string,
  ecoBackfillSteps: InfraStep[],
  infraSteps: InfraStep[],
  flipPointAbsHour: number,
  catalog: UnitCatalog,
  buildings: BuildingsFile,
): number {
  const reqs = getUnitBuildingRequirements(unitId, catalog, buildings);
  let readiness = flipPointAbsHour;
  for (const [bldgId, lvl] of reqs) {
    const step = [...ecoBackfillSteps, ...infraSteps].find(s => s.buildingId === bldgId && s.toLevel === lvl);
    readiness = Math.max(readiness, step ? step.endHour : flipPointAbsHour);
  }
  return readiness;
}

/**
 * Time-aware greedy scheduler for a dead-window city's mob queue — replaces the
 * fixed Smith's-rule-sorted walk (used for every other slot) because filler units
 * become ELIGIBLE at different times (uav needs only air_base L1, warhead needs
 * secret_weapons_lab, both much earlier than the primary unit's full chain), and a
 * fixed sort-then-walk would either waste the early window entirely (if the
 * lowest-ratio-but-latest-eligible filler is processed first) or lock in whichever
 * filler started first regardless of a cheaper one becoming eligible later.
 *
 * Fillers (every entry except `primaryUnitId`) are scheduled greedily: at each
 * point the queue frees up, mobilise whichever currently-eligible (readiness hour
 * already reached), not-yet-scheduled filler has the LOWEST Smith's ratio —
 * re-evaluated at each step, not decided once upfront. This uses genuinely idle
 * time (nothing else is eligible yet) for an early-ready-but-costlier filler
 * (uav), then prefers a later-eligible-but-cheaper filler (warhead, ratio 0) once
 * it comes online, for any of the queue's remaining capacity.
 *
 * The primary unit is scheduled last, JIT-delayed exactly as the default walk
 * does (latest safe start that still finishes by the deadline) — since it's
 * always the highest-ratio entry, delaying it minimises upkeep exactly as today;
 * inserting fillers into genuinely idle time ahead of it doesn't push its own
 * timeline later unless the fillers' total duration exceeds the dead window.
 */
function scheduleDeadWindowMobQueue(
  mobQueue: MobQueueEntry[],
  primaryUnitId: string,
  readinessHourByUnit: Map<string, number>,
  l1EndByUnit: Map<string, number>,
  deadlineAbsHour: number,
): CityForceProjectionSlot["mobSteps"] {
  const fillers = mobQueue.filter(e => e.unitId !== primaryUnitId);
  const primaryEntries = mobQueue.filter(e => e.unitId === primaryUnitId);
  const scheduled: CityForceProjectionSlot["mobSteps"] = [];

  let currentTime = fillers.length > 0
    ? Math.min(...fillers.map(e => readinessHourByUnit.get(e.unitId) ?? 0))
    : 0;
  const remaining = [...fillers];
  while (remaining.length > 0) {
    const eligible = remaining.filter(e => (readinessHourByUnit.get(e.unitId) ?? 0) <= currentTime);
    if (eligible.length === 0) {
      currentTime = Math.min(...remaining.map(e => readinessHourByUnit.get(e.unitId) ?? 0));
      continue;
    }
    eligible.sort((a, b) => a.smithRatio - b.smithRatio);
    const next = eligible[0];
    const start = Math.max(currentTime, l1EndByUnit.get(next.unitId) ?? 0);
    const end = start + next.totalMobHours;
    scheduled.push({ unitId: next.unitId, count: next.count, startAbsHour: start, endAbsHour: end, durationHours: next.totalMobHours });
    currentTime = end;
    remaining.splice(remaining.indexOf(next), 1);
  }

  const primaryTotalHours = primaryEntries.reduce((s, e) => s + e.totalMobHours, 0);
  let cumBefore = 0;
  for (const entry of primaryEntries) {
    const totalFromHere = primaryTotalHours - cumBefore;
    const jitMobStart = deadlineAbsHour - totalFromHere;
    const readiness = readinessHourByUnit.get(entry.unitId) ?? 0;
    const l1End = l1EndByUnit.get(entry.unitId) ?? 0;
    const start = Math.max(currentTime + cumBefore, readiness, jitMobStart, l1End);
    const end = start + entry.totalMobHours;
    scheduled.push({ unitId: entry.unitId, count: entry.count, startAbsHour: start, endAbsHour: end, durationHours: entry.totalMobHours });
    cumBefore += entry.totalMobHours;
  }

  return scheduled.sort((a, b) => a.startAbsHour - b.startAbsHour);
}

// ── Public types ──────────────────────────────────────────────────────────

export type CityForceProjectionSlot = {
  cityId: string;
  roLevel: number;
  primaryUnitId: string;
  mobQueue: MobQueueEntry[];
  infraOpenHour: number;
  /** The real, research-aware flip point: latest hour this city can still run
   *  eco builds before switching to military infra to hit the deadline. */
  flipPointAbsHour: number;
  /** Guaranteed future infra steps pulled forward into the idle eco window (between
   *  the eco phase's last organic build and the flip point). Structurally disjoint
   *  from `infraSteps` — once a level is backfilled it's excluded from
   *  `infraSteps`'s remaining chain by construction (see buildCityInfraStepsFromEco).
   *  Always empty for the formula-based fallback path (no eco result to backfill from). */
  ecoBackfillSteps: InfraStep[];
  infraSteps: InfraStep[];
  mobSteps: Array<{ unitId: string; count: number; startAbsHour: number; endAbsHour: number; durationHours: number }>;
};

export type CountryForceProjectionInput = {
  country: Country;
  doctrine: string;
  status: "homeland" | "occupied";
  demands: Demand[];
  scenario: ScenarioFile;
  buildings: BuildingsFile;
  catalog: UnitCatalog;
  scenarioAbsHour: number;
  deadlineAbsHour: number;
  truceDays: number;
  maxRoLevel: number;
  /** Pre-computed plan weights (e.g. shared with Unit 1.5's actual eco build). When
   *  provided, skips the internal computePlanWeights call to avoid two independent
   *  computations of "the same" weights drifting apart. */
  planWeights?: PlanWeights;
  /** Unit 1.5 "actual eco build" results, keyed by bare cityId. When a city has an
   *  entry, its infra chain is eco-credited (buildCityInfraStepsFromEco) instead of
   *  built from scratch — fixes the double-build bug. Cities without an entry (or
   *  when the whole map is absent) fall back to the formula-based chain. */
  actualEcoResultsByCity?: Map<string, CityEcoResult>;
  /** Idle slot time (game-hours) reserved before every JIT-scheduled (level 2+)
   *  research task — see coalition-force-plan-schema.ts's research_buffer_hours.
   *  Omitted/0 preserves zero-margin JIT scheduling. */
  researchBufferHours?: number;
  /** Hand-specified unit levels to force ASAP (exempt from JIT deferral and from
   *  researchBufferHours) — see coalition-force-plan-schema.ts's research_asap_pins. */
  researchAsapPins?: ResearchAsapPin[];
};

export type CountryForceProjectionResult = {
  countryName: string;
  moraleAtStart: number;
  moraleAtDeadline: number;
  researchSegments: UnitResearchSegment[];
  citySlots: CityForceProjectionSlot[];
  costs: {
    infraRo: ResourceCost;
    infraBuildings: ResourceCost;
    mobilisation: ResourceCost;
    upkeep: ResourceCost;
    provinceMobilisation: ResourceCost;
    provinceUpkeep: ResourceCost;
    total: ResourceCost;
  };
  provinceMobResults: ProvinceMobilizationPlan[];
  demandLabels: string[];
  skippedDemands: Demand[];
  /** Units with NO mobilisation data at all for this country's doctrine — a
   *  catalog data gap. Distinct from skippedDemands (genuine zero-mob-cost
   *  launcher platforms) — these are silently-would-be-wrong if not surfaced. */
  missingDataDemands: Demand[];
  infeasible: boolean;
  /** Set only on early-exit (no demands / no city-mobilised demands); citySlots etc. are empty. */
  reason?: "no_demands" | "no_active_demands";
  /** Resource weights actually used (either input.planWeights, or computed internally). */
  planWeights: PlanWeights;
};

// ── Main entry point ─────────────────────────────────────────────────────

export function computeCountryForceProjection(input: CountryForceProjectionInput): CountryForceProjectionResult {
  const {
    country, doctrine, status, demands, scenario, buildings, catalog,
    scenarioAbsHour, deadlineAbsHour, truceDays, maxRoLevel,
    planWeights: inputPlanWeights, actualEcoResultsByCity,
    researchBufferHours, researchAsapPins,
  } = input;

  const countryName = country.country.name;
  const isOccupied = status === "occupied";
  const moraleAtAbsHour: MoraleAtHour = (absHour) => {
    const day = Math.floor(absHour / 24) + 1;
    // TODO: use captured morale curve when an occupied morale function is available
    return isOccupied ? 50 : baselineHomelandMoraleOnDay(day);
  };

  const emptyCosts = { infraRo: {}, infraBuildings: {}, mobilisation: {}, upkeep: {}, provinceMobilisation: {}, provinceUpkeep: {}, total: {} };

  if (demands.length === 0) {
    return {
      countryName,
      moraleAtStart: moraleAtAbsHour(scenarioAbsHour),
      moraleAtDeadline: moraleAtAbsHour(deadlineAbsHour),
      researchSegments: [],
      citySlots: [],
      costs: emptyCosts,
      provinceMobResults: [],
      demandLabels: [],
      skippedDemands: [],
      missingDataDemands: [],
      infeasible: true,
      reason: "no_demands",
      planWeights: inputPlanWeights ?? {},
    };
  }

  const { provinceDemands, launcherDemands, activeDemands, missingDataDemands } = classifyDemands(demands, doctrine, catalog);

  if (activeDemands.length === 0) {
    return {
      countryName,
      moraleAtStart: moraleAtAbsHour(scenarioAbsHour),
      moraleAtDeadline: moraleAtAbsHour(deadlineAbsHour),
      researchSegments: [],
      citySlots: [],
      costs: emptyCosts,
      provinceMobResults: [],
      demandLabels: [],
      skippedDemands: launcherDemands,
      missingDataDemands,
      infeasible: true,
      reason: "no_active_demands",
      planWeights: inputPlanWeights ?? {},
    };
  }

  type DemandResult = { demand: Demand; batchSize: number; effectiveCount: number };
  const demandResults: DemandResult[] = activeDemands.map(demand => {
    const batchSize = getBatchSize(demand.unitId, catalog);
    return { demand, batchSize, effectiveCount: Math.ceil(demand.count / batchSize) };
  });

  // ── Joint demand optimization — fold-in algorithm ─────────────────────────
  const countryAllCityIds = country.cities.map(c => c.id);

  const planWeights: PlanWeights = inputPlanWeights ?? computePlanWeights(
    activeDemands.map(d => ({
      unitId: d.unitId,
      effectiveCount: Math.ceil(d.count / getBatchSize(d.unitId, catalog)),
    })),
    catalog,
    doctrine,
    truceDays,
  );

  const foldResult = foldInDemands(
    activeDemands.map(d => ({
      unitId: d.unitId,
      effectiveCount: Math.ceil(d.count / getBatchSize(d.unitId, catalog)),
      preferredCities: d.preferred_cities,
      minRo: d.min_ro,
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
      { ...scenario, truce_length_days: truceDays },
      { deadlineAbsoluteHour: deadlineAbsHour, doctrine, slots: 1 },
    ).maxLevel;
  }

  // Launcher-platform units (e.g. missiles) are never mobilised — correctly
  // excluded from activeDemands/foldInDemands above — but they still have real
  // research data and are needed to make the warheads they fire usable. Feed them
  // into the research schedule too, without a latestCompletionByUnitLevel L1
  // anchor (they have no city mob-queue to derive one from): their impact score
  // (mob + upkeep, both zero) is minimal, so the existing "higher weight → more
  // deferred" priority rule should schedule them early relative to real-upkeep
  // units on its own.
  for (const demand of launcherDemands) {
    const uid = demand.unitId;
    unitDemandCounts[uid] = demand.count;
    researchTargets[uid] = determineMaximumFeasibleLevel(
      catalog, uid,
      { ...scenario, truce_length_days: truceDays },
      { deadlineAbsoluteHour: deadlineAbsHour, doctrine, slots: 1 },
    ).maxLevel;
  }

  // For each city slot, derive the JIT mob start for each entry and update
  // the L1 constraint: L1 must complete before its mob window opens.
  //
  // Dead-window slots (see isDeadWindowSlot below) are a special case here: a
  // filler unit's real mob-eligible hour depends on the actual dead-window infra
  // chain (built later, in the per-city loop below) — not yet known at this
  // point. Using the default sequential formula (`infraOpenHour + cumBefore`, the
  // FULL primary-unit chain plus everyone queued ahead of it) would force the
  // filler's L1 research to a needlessly-late JIT deadline, defeating the whole
  // dead-window mechanic (confirmed empirically: warhead research JIT'd to hour
  // ~247 instead of completing by ~53, when secret_weapons_lab + arms_industry L1
  // are actually done). `slot.flipPointHour` is NOT a safe stand-in either — it's
  // the PRIMARY unit's own latest-safe-flip point, which can be late when the
  // primary has plenty of slack before the deadline (confirmed empirically: using
  // it pushed the constraint to hour ~458, worse than doing nothing). Instead,
  // estimate the filler's OWN minimal build time from scratch (ignoring the
  // primary's chain and any eco credit entirely) — independent of the primary
  // unit's timing, and safely early since it assumes no eco head start at all.
  for (const slot of foldResult.citySlots) {
    const deadWindow = isDeadWindowSlot(slot.mobQueue, catalog, buildings);
    let cumBefore = 0;
    for (const entry of slot.mobQueue) {
      const totalFromHere = slot.usedHours - cumBefore;
      const jitMobStart = deadlineAbsHour - totalFromHere;
      const actualMobStart = deadWindow && entry.unitId !== slot.primaryUnitId
        ? scenarioAbsHour + sumRequiredBuildHoursFromScratch(entry.unitId, catalog, buildings)
        : Math.max(slot.infraOpenHour + cumBefore, jitMobStart);
      const key = `${entry.unitId}:1`;
      const cur = latestCompletionByUnitLevel[key] ?? Infinity;
      if (actualMobStart < cur) latestCompletionByUnitLevel[key] = actualMobStart;
      cumBefore += entry.totalMobHours;
    }
  }

  // Hand-specified ASAP pins (see research_asap_pins schema comment): overwrite the
  // JIT deadline for specific unit levels with their earliest physically feasible
  // completion hour, forcing the backward scheduler to place them ASAP instead of
  // deferring them to the deadline. Also exempt them (level >= 2 only — level 1 is
  // already buffer-exempt) from researchBufferHours, since packing a hand-pinned
  // chain (e.g. a research-only prerequisite anchor never itself mobilised) tightly
  // is the entire point — spacing it out with buffer gaps would defeat the pin.
  const noBufferTaskIds = new Set<string>();
  if (researchAsapPins && researchAsapPins.length > 0) {
    const asapCompletions = computeAsapResearchCompletions(
      catalog, researchAsapPins, { ...scenario, truce_length_days: truceDays }, doctrine,
    );
    for (const pin of researchAsapPins) {
      for (const level of pin.levels) {
        const taskId = `${pin.unit}:${level}`;
        const completion = asapCompletions.get(taskId);
        if (completion === undefined) continue;
        latestCompletionByUnitLevel[taskId] = completion;
        if (level !== 1) noBufferTaskIds.add(taskId);
      }
    }
  }

  const combinedResearch = simulateUnitResearchTargets(
    catalog,
    researchTargets,
    { ...scenario, truce_length_days: truceDays },
    {
      enableJitScheduling: true, doctrine, latestCompletionByUnitLevel, unitDemandCounts,
      bufferHours: researchBufferHours, noBufferTaskIds,
    },
  );

  // ── Per-city flip point, infra steps, mob steps ───────────────────────────
  const citySlots: CityForceProjectionSlot[] = foldResult.citySlots.map((slot: CityMobSlot) => {
    const primaryUnitId = slot.primaryUnitId;

    const ecoResult = actualEcoResultsByCity?.get(slot.cityId);
    const deadWindow = isDeadWindowSlot(slot.mobQueue, catalog, buildings);
    const orderBuildingsOverride = deadWindow ? makeDeadWindowOrderBuildings(planWeights, buildings) : undefined;

    // The target hour the infra chain must be DONE by. Default: treat the whole
    // queue as one back-to-back block (deadline − combined total hours of every
    // entry) — correct when everything genuinely waits for infra to finish. WRONG
    // for a dead-window slot: fillers already mobilise independently, much
    // earlier, via their own readiness (see scheduleDeadWindowMobQueue above) —
    // using the combined total here would force infra to a needlessly EARLY
    // target (confirmed empirically: a ~190h/8-day gap opened up between infra
    // actually finishing and the primary unit's real JIT mob start, silently
    // shortening the eco phase for no reason, since the flip-point formula reads
    // this value as "how much total build time is really needed"). For a
    // dead-window slot, only the PRIMARY unit's own JIT timing should drive it.
    const primaryEntries = slot.mobQueue.filter(e => e.unitId === primaryUnitId);
    const primaryTotalHours = primaryEntries.reduce((s, e) => s + e.totalMobHours, 0);
    const primaryL1End = combinedResearch.segments.find(
      s => s.unitId === primaryUnitId && s.level === 1,
    )?.endAbsoluteHourExclusive ?? deadlineAbsHour;
    const firstEntry = slot.mobQueue[0];
    const firstL1EndForJit = combinedResearch.segments.find(
      s => s.unitId === firstEntry?.unitId && s.level === 1,
    )?.endAbsoluteHourExclusive ?? deadlineAbsHour;
    // A non-dead-window queue that's entirely zero-upkeep (e.g. a pure
    // conventional_warhead overflow city) gains nothing from deadline-JIT-anchoring
    // — there's no upkeep-days to save by delaying, and doing so strands the city
    // idle for however long remains between its infra finishing and the deadline-
    // anchored target, even after the eco phase has exhausted every profitable
    // action. Drop the deadline term in that case so the flip point (derived from
    // firstMobStart below) lands as early as infra/research allow instead.
    const allZeroUpkeep = slot.mobQueue.every(e => e.upkeepRateScalar === 0);
    const firstMobStart = deadWindow
      ? Math.max(slot.infraOpenHour, deadlineAbsHour - primaryTotalHours, primaryL1End)
      : allZeroUpkeep
        ? Math.max(slot.infraOpenHour, firstL1EndForJit)
        : Math.max(slot.infraOpenHour, deadlineAbsHour - slot.usedHours, firstL1EndForJit);

    function buildChain(extra?: Partial<Record<string, number>>): {
      flipPointAbsHour: number; infraSteps: InfraStep[]; ecoBackfillSteps: InfraStep[]; infraDoneHour: number;
    } {
      if (ecoResult) {
        // Eco-credited path: skips levels the Unit 1.5 actual eco build already
        // completed and iteratively re-derives the flip point accordingly — fixes
        // the double-build bug and captures more eco income when the eco phase got
        // a head start. Also backfills guaranteed-but-unscored levels into any idle
        // window before the flip point (see buildCityInfraStepsFromEco's docstring).
        const built = buildCityInfraStepsFromEco(
          primaryUnitId, slot.roLevel, firstMobStart, scenarioAbsHour, planWeights, catalog, buildings, ecoResult, orderBuildingsOverride, extra,
        );
        return { flipPointAbsHour: built.flipPointAbsHour, infraSteps: built.steps, ecoBackfillSteps: built.ecoBackfillSteps, infraDoneHour: built.mobOpenHour };
      }
      // Formula-based fallback (no Unit 1.5 result for this city): the real flip
      // point is the latest hour this city can still be running eco builds before
      // it must switch to military infra to hit the deadline. (slot.flipPointHour
      // is a simpler, research-unaware version of the same idea — this one
      // additionally accounts for L1 research completion timing.)
      const infraBuildHours = slot.infraOpenHour - scenarioAbsHour;
      const flipPointAbsHour = Math.max(scenarioAbsHour, firstMobStart - infraBuildHours);
      const built = buildCityInfraSteps(primaryUnitId, slot.roLevel, flipPointAbsHour, planWeights, catalog, buildings, orderBuildingsOverride, extra);
      return { flipPointAbsHour, infraSteps: built.steps, ecoBackfillSteps: [], infraDoneHour: built.mobOpenHour };
    }

    let chain = buildChain(undefined);

    // Dead-window slots often have real idle build-queue capacity left after the
    // bare-required chain (the primary unit typically only needs arms_industry
    // L1, e.g. SASF) finishes before the primary's own JIT-mob-start target
    // (`firstMobStart`, fixed above). arms_industry's own production_bonus_pct
    // makes further investment there a genuine, always-beneficial use of that
    // idle capacity (boosts whichever resource this city produces — electronics
    // for New Delhi, supplies for Mumbai/Kolkata) — PROVIDED it's bounded to
    // what actually fits. An earlier version of this boosted unconditionally to
    // the max defined level and let computeFlipPoint "sort it out" — but
    // computeFlipPoint only pushes the FLIP POINT earlier to make a longer chain
    // fit within the SAME firstMobStart target; it doesn't push firstMobStart
    // itself later, so an unbounded boost silently pushed the primary unit's own
    // mobilisation past the truce deadline (confirmed empirically: SASF mobStart
    // moved from 494 to a chain that didn't finish until 794, well past the
    // 687 deadline — infeasible). Fixed by measuring the REAL idle capacity
    // first (baseline chain's completion vs. firstMobStart) and only adding as
    // many arms_industry levels as fit within it, one at a time.
    if (deadWindow) {
      const baseRequiredLevels = requiredLevelsForUnit(primaryUnitId, slot.roLevel, catalog, buildings);
      const idleCapacity = firstMobStart - chain.infraDoneHour;
      if ("arms_industry" in baseRequiredLevels && idleCapacity > 0) {
        const aiLevels = buildings.buildings["arms_industry"]?.levels ?? {};
        const maxLevel = Object.keys(aiLevels).length;
        const baseLevel = baseRequiredLevels.arms_industry;
        let boostedLevel = baseLevel;
        let cumHours = 0;
        for (let lvl = baseLevel + 1; lvl <= maxLevel; lvl++) {
          const bt = (aiLevels[lvl as unknown as keyof typeof aiLevels] as { build_time?: { days?: number; hours?: number; minutes?: number } } | undefined)?.build_time;
          const hours = bt ? Math.ceil(durationToHours(bt)) : 0;
          if (hours <= 0 || cumHours + hours > idleCapacity) break;
          cumHours += hours;
          boostedLevel = lvl;
        }
        if (boostedLevel > baseLevel) {
          const boosted = buildChain({ arms_industry: boostedLevel });
          // Defensive: only adopt the boosted chain if it genuinely still fits —
          // provably true by construction (bounded to idleCapacity above), but
          // never trust a feasibility-sensitive change without checking it held.
          if (boosted.infraDoneHour <= firstMobStart + 0.5) chain = boosted;
        }
      }
    }

    const { flipPointAbsHour, infraSteps, ecoBackfillSteps, infraDoneHour } = chain;

    let mobSteps: CityForceProjectionSlot["mobSteps"];
    if (deadWindow) {
      // Dead-window slot: fillers (e.g. warhead/uav/awacs) become mobilisation-
      // eligible at different hours than the primary unit's full chain — see
      // scheduleDeadWindowMobQueue's docstring for why this needs a time-aware
      // greedy scheduler instead of the fixed Smith's-rule-sorted walk below.
      const uniqueUnitIds = [...new Set(slot.mobQueue.map(e => e.unitId))];
      const readinessHourByUnit = new Map(uniqueUnitIds.map(id => [
        id,
        computeReadinessHour(id, ecoBackfillSteps, infraSteps, flipPointAbsHour, catalog, buildings),
      ]));
      const l1EndByUnit = new Map(uniqueUnitIds.map(id => [
        id,
        combinedResearch.segments.find(s => s.unitId === id && s.level === 1)?.endAbsoluteHourExclusive ?? deadlineAbsHour,
      ]));
      mobSteps = scheduleDeadWindowMobQueue(slot.mobQueue, primaryUnitId, readinessHourByUnit, l1EndByUnit, deadlineAbsHour);
    } else {
      mobSteps = [];
      let cumBefore = 0;
      for (const entry of slot.mobQueue) {
        const totalFromHere = slot.usedHours - cumBefore;
        const jitMobStart = deadlineAbsHour - totalFromHere;
        const l1End = combinedResearch.segments.find(
          s => s.unitId === entry.unitId && s.level === 1,
        )?.endAbsoluteHourExclusive ?? deadlineAbsHour;
        // Zero-upkeep units (e.g. conventional_warhead) have nothing to gain from
        // deadline-JIT-anchoring — delaying mob start saves no upkeep-days, so
        // anchoring to jitMobStart here just strands the city idle once the eco
        // phase has exhausted every profitable/required action, for no benefit.
        // Start as soon as infra + research allow instead.
        const mobStart = entry.upkeepRateScalar === 0
          ? Math.max(infraDoneHour + cumBefore, l1End)
          : Math.max(infraDoneHour + cumBefore, jitMobStart, l1End);
        const mobEnd = mobStart + entry.totalMobHours;

        mobSteps.push({
          unitId: entry.unitId,
          count: entry.count,
          startAbsHour: mobStart,
          endAbsHour: mobEnd,
          durationHours: entry.totalMobHours,
        });
        cumBefore += entry.totalMobHours;
      }
    }

    return {
      cityId: slot.cityId,
      roLevel: slot.roLevel,
      primaryUnitId,
      mobQueue: slot.mobQueue,
      infraOpenHour: slot.infraOpenHour,
      flipPointAbsHour,
      ecoBackfillSteps,
      infraSteps,
      mobSteps,
    };
  });

  // ── Mobilisation Cost Summary — aggregate across all demands ─────────────
  const demandLabels = demandResults.map(({ demand, batchSize, effectiveCount }) => {
    const batchNote = batchSize > 1 ? ` (${effectiveCount} mob events)` : "";
    return `${demand.unitId.replaceAll("_", " ")} ×${demand.count}${batchNote}`;
  });

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
      aggInfraBldg = sumResourceCosts(aggInfraBldg, buildingRequirementsCost(uid, 1, catalog, buildings));
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
            catalog,
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

  const infeasible = foldResult.citySlots.length === 0 && provinceMobResults.length === 0;
  const aggTotal = sumResourceCosts(aggInfraRo, aggInfraBldg, aggMob, aggUpkeep, aggProvinceMob, aggProvinceUpkeep);

  return {
    countryName,
    moraleAtStart: moraleAtAbsHour(scenarioAbsHour),
    moraleAtDeadline: moraleAtAbsHour(deadlineAbsHour),
    researchSegments: combinedResearch.segments,
    citySlots,
    costs: {
      infraRo: aggInfraRo,
      infraBuildings: aggInfraBldg,
      mobilisation: aggMob,
      upkeep: aggUpkeep,
      provinceMobilisation: aggProvinceMob,
      provinceUpkeep: aggProvinceUpkeep,
      total: aggTotal,
    },
    provinceMobResults,
    demandLabels,
    skippedDemands: launcherDemands,
    missingDataDemands,
    infeasible,
    planWeights,
  };
}
