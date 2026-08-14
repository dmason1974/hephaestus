/**
 * Joint city optimizer — fold-in algorithm.
 *
 * Establishes a city footprint for the heaviest demand (highest infra cost),
 * then folds in each subsequent demand in heaviness order. For each fold-in,
 * the algorithm checks whether units are cheaper to absorb into existing cities
 * (at zero marginal infra cost when the city already satisfies the unit's building
 * requirements) or to open new dedicated cities. Within each city the mob queue is
 * ordered ascending by total burden (upkeepRateScalar × count) so that
 * low-burden batches mob first and high-burden batches mob last (JIT).
 *
 * All cost comparisons use plan-derived resource weights so that scarce resources
 * (those heavily consumed by the force plan) dominate the ranking.
 */

import type { Resource } from "../../core/constants.js";
import type { BuildingsFile } from "../../schemas/building-schema.js";
import type { UnitCatalog } from "../../schemas/unit-schema.js";
import type { ResourceCost } from "./types.js";
import {
  calculateBuildingCost,
  calculateMobilizationCost,
  calculateMobilizationDuration,
  calculateUpkeepCost,
  resourceCostToScalar,
} from "./cost-calculator.js";
import { durationToHours } from "../timing/activity-duration.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Returns the morale percentage (0–100) at a given absolute game hour. */
export type MoraleAtHour = (absHour: number) => number;

// ── Public types ─────────────────────────────────────────────────────────────

export type PlanWeights = Partial<Record<Resource, number>>;

/** One unit type's allocation within a city's mobilisation queue. */
export type MobQueueEntry = {
  unitId: string;
  count: number;
  /** Total hours this batch occupies in the mob slot (count × T_per_unit). */
  totalMobHours: number;
  /** Total burden = upkeepRateScalar × count. Queue sorted ascending: lowest total burden mobs first. */
  smithRatio: number;
  /** Plan-weighted upkeep scalar per unit per hour. */
  upkeepRateScalar: number;
  /** Hours per unit at the city's RO level. */
  tPerUnit: number;
};

/** A city with its committed infrastructure and ordered mobilisation queue. */
export type CityMobSlot = {
  cityId: string;
  roLevel: number;
  /** Unit ID that determined the non-RO infrastructure built in this city. */
  primaryUnitId: string;
  /** Mob queue ordered by smithRatio ascending (lowest total burden mobs first). */
  mobQueue: MobQueueEntry[];
  /** Hours available for mob from infra-open to deadline. */
  windowHours: number;
  /** Committed mob hours (sum of queue entries). */
  usedHours: number;
  /** Absolute hour when city infra + RO completes and mob can start. */
  infraOpenHour: number;
  /** Latest safe hour to flip from eco to military infra (mobStart − infra hours,
   * clamped to scenario start). Assumes a fresh full infra build — doesn't credit
   * any partial eco-phase progress toward the requirement. */
  flipPointHour: number;
};

export type JointCityResult = {
  citySlots: CityMobSlot[];
  planWeights: PlanWeights;
  /** Demand unit IDs in the order they were processed (heaviest first). */
  foldOrder: string[];
};

// ── Plan weights ─────────────────────────────────────────────────────────────

/**
 * Accumulates raw (unnormalised) L1 mobilisation + avg-upkeep resource footprint
 * for a demand list into `into` (or a fresh object). Shared by `computePlanWeights`
 * (per-country, normalised to a 0..1 weight) and `computeCoalitionPlanWeights`
 * (coalition-wide, one accumulator fed by every homeland country's own demands
 * before normalising once at the end).
 */
export function accumulateDemandResourceTotals(
  demands: Array<{ unitId: string; effectiveCount: number }>,
  catalog: UnitCatalog,
  doctrine: string,
  truceDays: number,
  into: Partial<Record<Resource, number>> = {},
): Partial<Record<Resource, number>> {
  const avgUpkeepHours = (truceDays * 24) / 2;

  for (const { unitId, effectiveCount } of demands) {
    for (const cost of [
      calculateMobilizationCost(unitId, 1, effectiveCount, catalog, doctrine),
      calculateUpkeepCost(unitId, 1, effectiveCount, avgUpkeepHours, catalog, doctrine),
    ]) {
      for (const [r, v] of Object.entries(cost) as [Resource, number][]) {
        if (v > 0) into[r] = (into[r] ?? 0) + v;
      }
    }
  }

  return into;
}

/**
 * Derives resource weights from the plan's aggregate L1 mob + upkeep footprint.
 * Resources not consumed by the plan get weight 0; the most-consumed resource
 * gets weight 1.0; others are proportional.
 */
export function computePlanWeights(
  demands: Array<{ unitId: string; effectiveCount: number }>,
  catalog: UnitCatalog,
  doctrine: string,
  truceDays: number,
): PlanWeights {
  const total = accumulateDemandResourceTotals(demands, catalog, doctrine, truceDays);

  const maxVal = Math.max(...(Object.values(total).filter(Boolean) as number[]), 1);
  const weights: PlanWeights = {};
  for (const [r, v] of Object.entries(total) as [Resource, number][]) {
    if (v > 0) weights[r as Resource] = v / maxVal;
  }
  return weights;
}

/**
 * Coalition-wide generalisation of `computePlanWeights`: derives resource weights
 * from the AGGREGATE L1 mob + avg-upkeep footprint across every homeland country's
 * own demands (each accumulated under its own doctrine), then normalised once at
 * the end — rather than each country's own narrow demand list.
 *
 * Why this matters for a pooled economy: `computePlanWeights` alone gives a
 * country's eco beam zero incentive to invest in a resource its OWN force plan
 * doesn't consume, even when that resource is exactly what the shared coalition
 * pool needs most (e.g. Italy's own demands barely touch electronics, so its
 * electronics-tile city's arms_industry investment would stall at a low level
 * under Italy's own weights — even though India/Japan's SASF/UAV-heavy demands
 * make electronics one of the coalition's most valuable pooled resources). Feeding
 * every country's eco beam this coalition-wide weight instead (while
 * `computeCountryForceProjection`'s fold-in keeps using each country's own
 * `computePlanWeights`, a genuinely country-scoped decision) lets every
 * resource-tile city invest according to what the coalition actually needs,
 * without ever touching the beam's own scoring/search logic — it only changes
 * which weights are handed to it, and the beam's own precedence is otherwise
 * unconditional.
 */
/**
 * Boost-only correction: for every resource with a genuine coalition-wide net
 * deficit, moves that resource's weight toward 1.0 proportional to how severe the
 * deficit is (relative to gross available — income + starting balance); resources
 * that are fine (net >= 0) are left completely untouched. Never reduces any
 * weight, so it can never cause the collateral starvation a bidirectional damping
 * multiplier can (a single city's investment can only ever become MORE attractive
 * here, never less) — the deficit signal comes from a REAL, already-simulated
 * coalition balance (computed after a first eco-beam pass), not a pre-estimate.
 */
export function boostWeightsFromDeficit(
  weights: PlanWeights,
  netPooledBalance: Partial<Record<Resource, number>>,
  grossAvailable: Partial<Record<Resource, number>>,
): PlanWeights {
  const boosted: PlanWeights = { ...weights };
  for (const r of Object.keys(netPooledBalance) as Resource[]) {
    const net = netPooledBalance[r] ?? 0;
    if (net >= 0) continue;
    const gross = grossAvailable[r] ?? 0;
    const deficitRatio = gross > 0 ? Math.min(1, -net / gross) : 1;
    const current = boosted[r] ?? 0;
    boosted[r] = current + deficitRatio * (1 - current);
  }
  return boosted;
}

export function computeCoalitionPlanWeights(
  countryDemands: Array<{ demands: Array<{ unitId: string; effectiveCount: number }>; doctrine: string }>,
  catalog: UnitCatalog,
  truceDays: number,
): PlanWeights {
  const total: Partial<Record<Resource, number>> = {};
  for (const { demands, doctrine } of countryDemands) {
    accumulateDemandResourceTotals(demands, catalog, doctrine, truceDays, total);
  }

  const maxVal = Math.max(...(Object.values(total).filter(Boolean) as number[]), 1);
  const weights: PlanWeights = {};
  for (const [r, v] of Object.entries(total) as [Resource, number][]) {
    if (v > 0) weights[r as Resource] = v / maxVal;
  }
  return weights;
}

// ── Building requirement helpers ─────────────────────────────────────────────

function getBuildingRequirements(
  unitId: string,
  catalog: UnitCatalog,
  buildings: BuildingsFile,
): Map<string, number> {
  const unit = catalog.units[unitId];
  const reqs = new Map<string, number>();
  if (!unit) return reqs;
  for (const req of unit.levels["1"]?.requirements ?? []) {
    const m = req.trim().match(/^(.+?)\s+level\s+(\d+)$/i);
    if (!m) continue;
    const bldgId = m[1].trim().replace(/ /g, "_");
    const lvl = parseInt(m[2]);
    if (catalog.units[bldgId]) continue;
    // mercenary_outpost can only be built in a province, never a city — never treat
    // it as a city building requirement, regardless of which unit lists it.
    if (bldgId === "mercenary_outpost") continue;
    if (buildings.buildings[bldgId]) reqs.set(bldgId, Math.max(reqs.get(bldgId) ?? 0, lvl));
  }
  return reqs;
}

export function getUnitMinRo(unitId: string, catalog: UnitCatalog): number {
  const unit = catalog.units[unitId];
  if (!unit) return 1;
  for (const req of unit.levels["1"]?.requirements ?? []) {
    const m = req.trim().match(/^recruiting_office\s+level\s+(\d+)$/i);
    if (m) return parseInt(m[1]);
  }
  return 1;
}

function nonRoBuildHours(unitId: string, catalog: UnitCatalog, buildings: BuildingsFile): number {
  const reqs = getBuildingRequirements(unitId, catalog, buildings);
  let total = 0;
  for (const [bldgId, targetLvl] of reqs) {
    if (bldgId === "recruiting_office") continue;
    const bldg = buildings.buildings[bldgId];
    if (!bldg) continue;
    for (let lvl = 1; lvl <= targetLvl; lvl++) {
      const bt = (bldg.levels[String(lvl)] as { build_time?: Record<string, number> } | undefined)
        ?.build_time;
      if (bt) total += Math.ceil(durationToHours(bt));
    }
  }
  return total;
}

function roBuildHoursRange(fromLevel: number, toLevel: number, buildings: BuildingsFile): number {
  if (toLevel <= fromLevel) return 0;
  const roBldg = buildings.buildings["recruiting_office"];
  if (!roBldg) return 0;
  let total = 0;
  for (let lvl = fromLevel + 1; lvl <= toLevel; lvl++) {
    const bt = (roBldg.levels[String(lvl)] as { build_time?: Record<string, number> } | undefined)
      ?.build_time;
    if (bt) total += Math.ceil(durationToHours(bt));
  }
  return total;
}

/** Sum of build times for levels 1..targetLevel of a single named building. */
function buildingLevelHoursSum(buildingId: string, targetLevel: number, buildings: BuildingsFile): number {
  const bldg = buildings.buildings[buildingId];
  if (!bldg) return 0;
  let total = 0;
  for (let lvl = 1; lvl <= targetLevel; lvl++) {
    const bt = (bldg.levels[String(lvl)] as { build_time?: Record<string, number> } | undefined)?.build_time;
    if (bt) total += Math.ceil(durationToHours(bt));
  }
  return total;
}

function infraCompatible(primaryUnitId: string, candidateUnitId: string, catalog: UnitCatalog, buildings: BuildingsFile): boolean {
  const primReqs = getBuildingRequirements(primaryUnitId, catalog, buildings);
  const candReqs = getBuildingRequirements(candidateUnitId, catalog, buildings);
  for (const [bldgId, lvlNeeded] of candReqs) {
    if (bldgId === "recruiting_office") continue;
    if ((primReqs.get(bldgId) ?? 0) < lvlNeeded) return false;
  }
  return true;
}

/**
 * Whether `candidateUnitId`'s requirements are a STRICT subset of
 * `primaryUnitId`'s (already confirmed non-strict-subset via `infraCompatible`
 * before this is called) — i.e. a genuine dead-window filler relationship
 * (warhead/uav/awacs vs. a SASF-style primary), not a coincidentally-identical
 * requirement set (where the old "shared window" absorption math is already
 * correct, since both would be ready at the same time anyway).
 */
function isGenuineDeadWindowFiller(candidateUnitId: string, primaryUnitId: string, catalog: UnitCatalog, buildings: BuildingsFile): boolean {
  const candReqs = getBuildingRequirements(candidateUnitId, catalog, buildings);
  const primReqs = getBuildingRequirements(primaryUnitId, catalog, buildings);
  if (candReqs.size !== primReqs.size) return true;
  for (const [bldgId, lvl] of candReqs) {
    if (primReqs.get(bldgId) !== lvl) return true;
  }
  return false;
}

// ── Cost helpers ─────────────────────────────────────────────────────────────

export function infraScalarForUnit(
  unitId: string,
  roLevel: number,
  catalog: UnitCatalog,
  buildings: BuildingsFile,
  weights: PlanWeights,
): number {
  const reqs = getBuildingRequirements(unitId, catalog, buildings);
  let total = resourceCostToScalar(calculateBuildingCost("recruiting_office", 0, roLevel, buildings), weights);
  for (const [bldgId, lvl] of reqs) {
    if (bldgId === "recruiting_office") continue;
    total += resourceCostToScalar(calculateBuildingCost(bldgId, 0, lvl, buildings), weights);
  }
  return total;
}

export function unitUpkeepRateScalar(
  unitId: string,
  catalog: UnitCatalog,
  doctrine: string,
  weights: PlanWeights,
): number {
  // Use the highest level with upkeep data for this doctrine.
  // Units will be near max level by the deadline (JIT research + auto-upgrade), so the
  // max-level rate drives the true ordering cost, not the L1 rate.
  const levels = catalog.units[unitId]?.levels ?? {};
  let maxLevel = 1;
  for (const lvlKey of Object.keys(levels)) {
    const lvl = Number(lvlKey);
    const upkeep = (levels[lvlKey] as { daily_upkeep?: Record<string, unknown> } | undefined)?.daily_upkeep;
    if (upkeep && Object.prototype.hasOwnProperty.call(upkeep, doctrine) && lvl > maxLevel) {
      maxLevel = lvl;
    }
  }
  const dailyCost = calculateUpkeepCost(unitId, maxLevel, 1, 24, catalog, doctrine);
  return resourceCostToScalar(dailyCost, weights) / 24;
}

export function infraHeaviness(
  unitId: string,
  catalog: UnitCatalog,
  buildings: BuildingsFile,
  weights: PlanWeights,
): number {
  const reqs = getBuildingRequirements(unitId, catalog, buildings);
  let total = 0;
  for (const [bldgId, lvl] of reqs) {
    if (bldgId === "recruiting_office") continue;
    total += resourceCostToScalar(calculateBuildingCost(bldgId, 0, lvl, buildings), weights);
  }
  return total;
}

// ── New-city cost estimation ───────────────────────────────────────────────────

export type NewCityEstimate = {
  roLevel: number;
  numCities: number;
  unitsPerCity: number;
  infraOpenHour: number;
  flipPointHour: number;
  totalCost: number;
};

export function estimateBestNewCityConfig(
  unitId: string,
  n: number,
  minRo: number,
  maxRo: number,
  maxCities: number,
  scenarioAbsHour: number,
  deadlineAbsHour: number,
  catalog: UnitCatalog,
  buildings: BuildingsFile,
  doctrine: string,
  moraleAtAbsHour: MoraleAtHour,
  weights: PlanWeights,
): NewCityEstimate | null {
  const baseInfraHours = nonRoBuildHours(unitId, catalog, buildings);
  const upkeepRate = unitUpkeepRateScalar(unitId, catalog, doctrine, weights);
  const mobCost = resourceCostToScalar(calculateMobilizationCost(unitId, 1, n, catalog, doctrine), weights);

  let best: NewCityEstimate | null = null;

  for (let ro = minRo; ro <= maxRo; ro++) {
    const totalInfraHours = baseInfraHours + roBuildHoursRange(0, ro, buildings);
    const infraOpenHour = scenarioAbsHour + totalInfraHours;
    const window = deadlineAbsHour - infraOpenHour;
    if (window <= 0) continue;

    // One-pass iteration: estimate T from deadline morale, derive JIT mob start, refine T.
    const T0 = calculateMobilizationDuration(unitId, 1, 1, 1, ro, catalog, buildings, doctrine, moraleAtAbsHour(deadlineAbsHour));
    if (T0 <= 0) continue;

    const infraCostPerCity = infraScalarForUnit(unitId, ro, catalog, buildings, weights);

    // Sweep city count from minimum feasible up to maxCities.
    const minCities = Math.ceil(n / Math.max(1, Math.floor(window / T0)));
    for (let nc = minCities; nc <= maxCities; nc++) {
      const unitsPerCity = Math.ceil(n / nc);
      // Derive morale at the JIT mob start for a city with unitsPerCity units
      const jitStart = Math.max(infraOpenHour, deadlineAbsHour - unitsPerCity * T0);
      const T = calculateMobilizationDuration(unitId, 1, 1, 1, ro, catalog, buildings, doctrine, moraleAtAbsHour(jitStart));
      if (unitsPerCity * T > window) continue; // infeasible after morale refinement

      const totalInfraCost = nc * infraCostPerCity;

      // Triangular upkeep: each city runs JIT, last unit finishes at deadline.
      let totalUpkeep = 0;
      for (let ci = 0; ci < nc; ci++) {
        const m = ci < n % nc ? Math.ceil(n / nc) : Math.floor(n / nc);
        totalUpkeep += upkeepRate * T * (m * (m + 1)) / 2;
      }

      const totalCost = totalInfraCost + mobCost + totalUpkeep;
      if (!best || totalCost < best.totalCost) {
        const flipPointHour = Math.max(scenarioAbsHour, jitStart - totalInfraHours);
        best = { roLevel: ro, numCities: nc, unitsPerCity, infraOpenHour, flipPointHour, totalCost };
      }
    }
  }

  return best;
}

// ── City slot construction ────────────────────────────────────────────────────

function buildNewSlot(
  cityId: string,
  unitId: string,
  unitsAllocated: number,
  roLevel: number,
  catalog: UnitCatalog,
  buildings: BuildingsFile,
  doctrine: string,
  moraleAtAbsHour: MoraleAtHour,
  weights: PlanWeights,
  scenarioAbsHour: number,
  deadlineAbsHour: number,
): CityMobSlot {
  const baseHours = nonRoBuildHours(unitId, catalog, buildings);
  const roHours = roBuildHoursRange(0, roLevel, buildings);
  const infraOpenHour = scenarioAbsHour + baseHours + roHours;
  const windowHours = deadlineAbsHour - infraOpenHour;

  // One-pass: estimate mob start from deadline morale, then use actual morale at that start
  const T0 = calculateMobilizationDuration(unitId, 1, 1, 1, roLevel, catalog, buildings, doctrine, moraleAtAbsHour(deadlineAbsHour));
  const jitStart = Math.max(infraOpenHour, deadlineAbsHour - unitsAllocated * T0);
  const T = calculateMobilizationDuration(unitId, 1, 1, 1, roLevel, catalog, buildings, doctrine, moraleAtAbsHour(jitStart));
  const rate = unitUpkeepRateScalar(unitId, catalog, doctrine, weights);
  const entry: MobQueueEntry = {
    unitId,
    count: unitsAllocated,
    totalMobHours: unitsAllocated * T,
    smithRatio: rate * unitsAllocated,
    upkeepRateScalar: rate,
    tPerUnit: T,
  };
  const flipPointHour = Math.max(scenarioAbsHour, jitStart - (baseHours + roHours));

  return {
    cityId,
    roLevel,
    primaryUnitId: unitId,
    mobQueue: [entry],
    windowHours,
    usedHours: entry.totalMobHours,
    infraOpenHour,
    flipPointHour,
  };
}

// ── Absorption ────────────────────────────────────────────────────────────────

type AbsorptionOption = {
  slotIdx: number;
  nAbsorbable: number;
  marginalCost: number;
  insertIdx: number;
  neededRo: number;
};

function evaluateAbsorptionOptions(
  slots: CityMobSlot[],
  unitId: string,
  maxN: number,
  minRo: number,
  catalog: UnitCatalog,
  buildings: BuildingsFile,
  doctrine: string,
  moraleAtAbsHour: MoraleAtHour,
  weights: PlanWeights,
  maxRoLevel: number,
  scenarioAbsHour: number,
): AbsorptionOption[] {
  const options: AbsorptionOption[] = [];

  for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
    const slot = slots[slotIdx];

    if (!infraCompatible(slot.primaryUnitId, unitId, catalog, buildings)) continue;

    const neededRo = Math.max(slot.roLevel, minRo);
    if (neededRo > maxRoLevel) continue;

    const roExtraHours = roBuildHoursRange(slot.roLevel, neededRo, buildings);
    const effectiveWindow = slot.windowHours - roExtraHours;
    if (effectiveWindow <= 0) continue;

    // Dead-window filler cap: a genuine filler (warhead/uav/awacs vs. a SASF-style
    // primary) doesn't wait for the primary's full infra chain — it becomes
    // eligible as soon as its OWN (much smaller) requirement set is built, and
    // mobilises in parallel with the primary's build queue. The default capacity
    // math below (`effectiveWindow - slot.usedHours`) assumes the WHOLE queue
    // shares one window starting at infra-open — correct for the primary itself
    // and for absorptions with identical requirements, but for a genuine filler
    // it overstates how much can be absorbed: confirmed empirically (Japan/Sendai)
    // that absorbing all 8 awacs into one SASF city pushed SASF's own mobilisation
    // past the truce deadline, because awacs doesn't actually free the queue until
    // its own (early) readiness + its own mob duration — which can still run past
    // the primary's JIT-optimal start if too much is packed into one city. Capped
    // here by a cheap, safe, primary-independent estimate — the filler's own
    // build time from scratch (ignoring RO progress/eco credit, same conservative
    // approximation used downstream in country-force-projection.ts's research
    // constraint) versus the primary's own deadline-driven JIT start (deadline
    // minus the primary's own total mob hours, NOT the combined-queue total).
    const deadWindowFiller = isGenuineDeadWindowFiller(unitId, slot.primaryUnitId, catalog, buildings);
    let deadWindowCapN = Infinity;
    if (deadWindowFiller) {
      const primaryEntry = slot.mobQueue.find(e => e.unitId === slot.primaryUnitId);
      if (primaryEntry) {
        const deadlineAbsHour = slot.infraOpenHour + slot.windowHours;
        const primaryJitStart = deadlineAbsHour - primaryEntry.totalMobHours;
        // Readiness estimate: slot.flipPointHour (already computed — the primary's
        // own latest-safe-flip point, i.e. roughly "when the required/military
        // phase begins") PLUS secret_weapons_lab's build time if the PRIMARY needs
        // it but this filler doesn't (it's built FIRST in the dead-window order —
        // see makeDeadWindowOrderBuildings in country-force-projection.ts — so it
        // delays every OTHER required building's start regardless of whether this
        // specific filler needs it) PLUS this filler's own required build time.
        // A pure "from scratch, ignoring the primary's other prerequisites"
        // estimate undercounts badly here (confirmed empirically: ~132h vs a real
        // ~314h for awacs in Sendai — missing both the eco phase before flip and
        // secret_weapons_lab's 25h ahead of it) — still an approximation (the real
        // eco-credited flip point isn't knowable this early, before Unit 1.5's eco
        // beam has run), but a much closer one.
        const primaryReqs = getBuildingRequirements(slot.primaryUnitId, catalog, buildings);
        const fillerReqs = getBuildingRequirements(unitId, catalog, buildings);
        const secretLabHours = primaryReqs.has("secret_weapons_lab") && !fillerReqs.has("secret_weapons_lab")
          ? buildingLevelHoursSum("secret_weapons_lab", primaryReqs.get("secret_weapons_lab") ?? 0, buildings)
          : 0;
        const fillerReadinessAbs = slot.flipPointHour + secretLabHours + nonRoBuildHours(unitId, catalog, buildings);
        const availableWindow = primaryJitStart - fillerReadinessAbs;
        deadWindowCapN = availableWindow > 0 ? Math.floor(availableWindow / Math.max(1, calculateMobilizationDuration(unitId, 1, 1, 1, neededRo, catalog, buildings, doctrine, moraleAtAbsHour(fillerReadinessAbs)))) : 0;
      }
    }
    const cappedMaxN = Math.min(maxN, deadWindowCapN);
    if (cappedMaxN <= 0) continue;

    // One-pass morale iteration: estimate T from deadline morale, derive JIT mob start, refine T
    const T0 = calculateMobilizationDuration(unitId, 1, 1, 1, neededRo, catalog, buildings, doctrine, moraleAtAbsHour(slot.infraOpenHour + slot.windowHours));
    if (T0 <= 0) continue;
    const remaining = effectiveWindow - slot.usedHours;
    const nEst = Math.min(cappedMaxN, Math.floor(remaining / T0));
    if (nEst <= 0) continue;
    const absorbedInfraOpen = slot.infraOpenHour + roExtraHours;
    const jitStart = Math.max(absorbedInfraOpen, slot.infraOpenHour + slot.windowHours - slot.usedHours - nEst * T0);
    const T = calculateMobilizationDuration(unitId, 1, 1, 1, neededRo, catalog, buildings, doctrine, moraleAtAbsHour(jitStart));
    if (T <= 0) continue;

    const nAbsorbable = Math.min(cappedMaxN, Math.floor(remaining / T));
    if (nAbsorbable <= 0) continue;

    const rate = unitUpkeepRateScalar(unitId, catalog, doctrine, weights);
    const newSmithRatio = rate * nAbsorbable;
    let insertIdx = slot.mobQueue.findIndex(e => e.smithRatio > newSmithRatio);
    if (insertIdx === -1) insertIdx = slot.mobQueue.length;

    // Extra upkeep on existing entries before insertIdx (pushed earlier by nAbsorbable × T hours)
    let existingUpkeepIncrease = 0;
    for (let i = 0; i < insertIdx; i++) {
      const e = slot.mobQueue[i];
      existingUpkeepIncrease += e.upkeepRateScalar * e.count * nAbsorbable * T;
    }

    // Own upkeep for new units
    const durationAfter = slot.mobQueue.slice(insertIdx).reduce((s, e) => s + e.totalMobHours, 0);
    const ownUpkeepHours = nAbsorbable * durationAfter + T * nAbsorbable * (nAbsorbable - 1) / 2;
    const ownUpkeepCost = rate * ownUpkeepHours;

    const mobCost = resourceCostToScalar(
      calculateMobilizationCost(unitId, 1, nAbsorbable, catalog, doctrine),
      weights,
    );

    const roUpgradeCost = neededRo > slot.roLevel
      ? resourceCostToScalar(
          calculateBuildingCost("recruiting_office", slot.roLevel, neededRo, buildings),
          weights,
        )
      : 0;

    options.push({
      slotIdx,
      nAbsorbable,
      marginalCost: existingUpkeepIncrease + ownUpkeepCost + mobCost + roUpgradeCost,
      insertIdx,
      neededRo,
    });
  }

  return options;
}

function applyAbsorption(
  slot: CityMobSlot,
  unitId: string,
  n: number,
  _insertIdx: number,
  neededRo: number,
  catalog: UnitCatalog,
  buildings: BuildingsFile,
  doctrine: string,
  moraleAtAbsHour: MoraleAtHour,
  weights: PlanWeights,
  scenarioAbsHour: number,
): void {
  if (neededRo > slot.roLevel) {
    const extra = roBuildHoursRange(slot.roLevel, neededRo, buildings);
    slot.roLevel = neededRo;
    slot.infraOpenHour += extra;
    slot.windowHours -= extra;
  }

  // One-pass morale iteration
  const deadlineAbsHour = slot.infraOpenHour + slot.windowHours;
  const T0 = calculateMobilizationDuration(unitId, 1, 1, 1, slot.roLevel, catalog, buildings, doctrine, moraleAtAbsHour(deadlineAbsHour));
  const jitStart = Math.max(slot.infraOpenHour, deadlineAbsHour - (slot.usedHours + n * T0));
  const T = calculateMobilizationDuration(unitId, 1, 1, 1, slot.roLevel, catalog, buildings, doctrine, moraleAtAbsHour(jitStart));
  const rate = unitUpkeepRateScalar(unitId, catalog, doctrine, weights);
  const burden = rate * n;
  let insertIdx = slot.mobQueue.findIndex(e => e.smithRatio > burden);
  if (insertIdx === -1) insertIdx = slot.mobQueue.length;

  const entry: MobQueueEntry = {
    unitId,
    count: n,
    totalMobHours: n * T,
    smithRatio: burden,
    upkeepRateScalar: rate,
    tPerUnit: T,
  };
  slot.mobQueue.splice(insertIdx, 0, entry);
  slot.usedHours += entry.totalMobHours;

  // Flip point reflects the whole queue's slack, not just this newly-absorbed
  // unit: latest the full queue's infra could open and still finish by deadline,
  // minus the total infra hours this slot currently requires.
  const totalInfraHoursForSlot = slot.infraOpenHour - scenarioAbsHour;
  const latestInfraOpenAcrossQueue = slot.infraOpenHour + slot.windowHours - slot.usedHours;
  slot.flipPointHour = Math.max(scenarioAbsHour, latestInfraOpenAcrossQueue - totalInfraHoursForSlot);
}

// ── Fixed-city-count cost estimation (for preferred_cities pinning) ──────────

/**
 * Like `estimateBestNewCityConfig`'s RO sweep, but with the city count pinned to
 * exactly `numCities` rather than searched — used when a demand carries
 * `preferred_cities` and must open exactly that many named cities regardless of
 * whether a different count would be cheaper.
 */
function estimateRoLevelForFixedCityCount(
  unitId: string,
  n: number,
  numCities: number,
  minRo: number,
  maxRo: number,
  scenarioAbsHour: number,
  deadlineAbsHour: number,
  catalog: UnitCatalog,
  buildings: BuildingsFile,
  doctrine: string,
  moraleAtAbsHour: MoraleAtHour,
  weights: PlanWeights,
): { roLevel: number; unitsPerCity: number } | null {
  const baseInfraHours = nonRoBuildHours(unitId, catalog, buildings);
  const upkeepRate = unitUpkeepRateScalar(unitId, catalog, doctrine, weights);
  const mobCost = resourceCostToScalar(calculateMobilizationCost(unitId, 1, n, catalog, doctrine), weights);

  let best: { roLevel: number; unitsPerCity: number; totalCost: number } | null = null;

  for (let ro = minRo; ro <= maxRo; ro++) {
    const totalInfraHours = baseInfraHours + roBuildHoursRange(0, ro, buildings);
    const infraOpenHour = scenarioAbsHour + totalInfraHours;
    const window = deadlineAbsHour - infraOpenHour;
    if (window <= 0) continue;

    const unitsPerCity = Math.ceil(n / numCities);
    const T0 = calculateMobilizationDuration(unitId, 1, 1, 1, ro, catalog, buildings, doctrine, moraleAtAbsHour(deadlineAbsHour));
    if (T0 <= 0) continue;
    const jitStart = Math.max(infraOpenHour, deadlineAbsHour - unitsPerCity * T0);
    const T = calculateMobilizationDuration(unitId, 1, 1, 1, ro, catalog, buildings, doctrine, moraleAtAbsHour(jitStart));
    if (T <= 0 || unitsPerCity * T > window) continue;

    const infraCostPerCity = infraScalarForUnit(unitId, ro, catalog, buildings, weights);
    const totalInfraCost = numCities * infraCostPerCity;

    let totalUpkeep = 0;
    for (let ci = 0; ci < numCities; ci++) {
      const m = ci < n % numCities ? Math.ceil(n / numCities) : Math.floor(n / numCities);
      totalUpkeep += upkeepRate * T * (m * (m + 1)) / 2;
    }

    const totalCost = totalInfraCost + mobCost + totalUpkeep;
    if (!best || totalCost < best.totalCost) {
      best = { roLevel: ro, unitsPerCity, totalCost };
    }
  }

  return best;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Folds all demands into a city plan using the incremental heaviness-first algorithm.
 *
 * @param demands  Active demands (province and launcher-platform demands excluded).
 *   A demand with `preferredCities` skips the cost-driven search and opens exactly
 *   those named cities instead (split evenly) — see the pinned pre-pass below.
 * @param cityIds  Available city IDs in priority order (capital first).
 * @param scenarioAbsHour  Absolute hour of game start.
 * @param deadlineAbsHour  Absolute hour of the truce deadline.
 */
export function foldInDemands(
  demands: Array<{ unitId: string; effectiveCount: number; preferredCities?: string[]; minRo?: number }>,
  cityIds: string[],
  catalog: UnitCatalog,
  buildings: BuildingsFile,
  doctrine: string,
  scenarioAbsHour: number,
  deadlineAbsHour: number,
  planWeights: PlanWeights,
  maxRoLevel: number,
  moraleAtAbsHour: MoraleAtHour,
): JointCityResult {
  const citySlots: CityMobSlot[] = [];

  // ── Pinned pre-pass: demands with preferred_cities open exactly those named
  // cities up front, splitting effectiveCount evenly across them, instead of
  // going through the cost-driven search below. Every OTHER (unpinned) demand
  // still runs the normal heaviness-sorted fold-in afterward — including trying
  // to absorb into these pinned slots via the existing infraCompatible/absorption
  // logic below, unchanged, which already treats a subset-requirement demand
  // (e.g. a warhead whose reqs are a strict subset of a SASF city's) as a valid
  // absorption candidate. Pinned cities are removed from the pool so the
  // unpinned overflow path never re-opens them as a dedicated city for something
  // else.
  const usedCityIds = new Set<string>();
  const pinnedDemands = demands.filter(d => d.preferredCities && d.preferredCities.length > 0);
  for (const demand of pinnedDemands) {
    const { unitId, effectiveCount, preferredCities } = demand;
    const numCities = preferredCities!.length;
    // Plan-level override (Demand.min_ro) can force a higher RO floor than this
    // demand alone would ever pick — needed when a later, separately-pinned
    // demand (e.g. awacs) will share this same city and needs more RO
    // throughput than the first demand (e.g. SASF) requires by itself.
    const minRo = Math.max(getUnitMinRo(unitId, catalog), demand.minRo ?? 0);
    const est = estimateRoLevelForFixedCityCount(
      unitId, effectiveCount, numCities, minRo, maxRoLevel,
      scenarioAbsHour, deadlineAbsHour, catalog, buildings, doctrine, moraleAtAbsHour, planWeights,
    );
    if (!est) continue; // infeasible even at max RO with this exact city count — skip, same as the unpinned overflow path's `if (!est) continue`
    const { roLevel, unitsPerCity } = est;

    for (let ci = 0; ci < numCities; ci++) {
      const cid = preferredCities![ci];
      const allocated = ci === numCities - 1
        ? effectiveCount - unitsPerCity * (numCities - 1)
        : unitsPerCity;

      // Two pinned demands can name the same city (e.g. SASF and uav both pinned
      // to mumbai) — merge into the existing slot's shared queue via the same
      // absorption machinery the unpinned path uses (including its dead-window
      // capacity cap), rather than pushing a second, duplicate CityMobSlot for the
      // same cityId. Without this, dead-window sharing between two *pinned*
      // demands silently doesn't happen — each ends up in its own disconnected
      // slot instead of one shared mob queue.
      const existingSlotIdx = citySlots.findIndex(s => s.cityId === cid);
      if (existingSlotIdx !== -1) {
        const options = evaluateAbsorptionOptions(
          citySlots, unitId, allocated, minRo, catalog, buildings, doctrine, moraleAtAbsHour, planWeights, maxRoLevel, scenarioAbsHour,
        ).filter(o => o.slotIdx === existingSlotIdx);
        if (options.length > 0) {
          const opt = options[0];
          applyAbsorption(
            citySlots[opt.slotIdx], unitId, Math.min(opt.nAbsorbable, allocated), opt.insertIdx, opt.neededRo,
            catalog, buildings, doctrine, moraleAtAbsHour, planWeights, scenarioAbsHour,
          );
        }
        usedCityIds.add(cid);
        continue;
      }

      citySlots.push(buildNewSlot(
        cid, unitId, allocated, roLevel,
        catalog, buildings, doctrine, moraleAtAbsHour, planWeights,
        scenarioAbsHour, deadlineAbsHour,
      ));
      usedCityIds.add(cid);
    }
  }

  const unpinnedDemands = demands.filter(d => !d.preferredCities || d.preferredCities.length === 0);
  const cityIdsForOverflow = cityIds.filter(id => !usedCityIds.has(id));

  const sorted = [...unpinnedDemands].sort(
    (a, b) =>
      infraHeaviness(b.unitId, catalog, buildings, planWeights) -
      infraHeaviness(a.unitId, catalog, buildings, planWeights),
  );

  let nextCityIdx = 0;

  for (const demand of sorted) {
    const { unitId, effectiveCount } = demand;
    const minRo = getUnitMinRo(unitId, catalog);
    let remaining = effectiveCount;

    // ── Try absorbing into existing compatible cities ──────────────────────
    const options = evaluateAbsorptionOptions(
      citySlots, unitId, remaining, minRo, catalog, buildings, doctrine, moraleAtAbsHour, planWeights, maxRoLevel, scenarioAbsHour,
    );

    // Sort by marginal cost per unit absorbed (most efficient absorption first)
    options.sort((a, b) => (a.marginalCost / a.nAbsorbable) - (b.marginalCost / b.nAbsorbable));

    for (const opt of options) {
      if (remaining <= 0) break;
      const n = Math.min(opt.nAbsorbable, remaining);

      // Compare: absorption cost for n vs cheapest new-city cost for n
      const remainingCities = cityIdsForOverflow.length - nextCityIdx;
      const newCityEst = estimateBestNewCityConfig(
        unitId, n, minRo, maxRoLevel, Math.max(1, remainingCities),
        scenarioAbsHour, deadlineAbsHour,
        catalog, buildings, doctrine, moraleAtAbsHour, planWeights,
      );

      // Scale marginal cost proportionally to n
      const scaledMarginal = opt.marginalCost * (n / opt.nAbsorbable);
      const newCityCost = newCityEst?.totalCost ?? Infinity;

      if (scaledMarginal <= newCityCost) {
        applyAbsorption(
          citySlots[opt.slotIdx], unitId, n, opt.insertIdx, opt.neededRo,
          catalog, buildings, doctrine, moraleAtAbsHour, planWeights, scenarioAbsHour,
        );
        remaining -= n;
      }
    }

    // ── Overflow: open new dedicated cities ───────────────────────────────
    if (remaining > 0) {
      const remainingCities = cityIdsForOverflow.length - nextCityIdx;
      const est = estimateBestNewCityConfig(
        unitId, remaining, minRo, maxRoLevel, Math.max(1, remainingCities),
        scenarioAbsHour, deadlineAbsHour,
        catalog, buildings, doctrine, moraleAtAbsHour, planWeights,
      );
      if (!est) continue;

      const { numCities, roLevel: bestRo, unitsPerCity } = est;

      for (let ci = 0; ci < numCities && nextCityIdx < cityIdsForOverflow.length; ci++) {
        // Last city gets the remainder; all others get unitsPerCity
        const allocated = ci === numCities - 1
          ? remaining - unitsPerCity * (numCities - 1)
          : unitsPerCity;
        const cid = cityIdsForOverflow[nextCityIdx++];
        citySlots.push(buildNewSlot(
          cid, unitId, allocated, bestRo,
          catalog, buildings, doctrine, moraleAtAbsHour, planWeights,
          scenarioAbsHour, deadlineAbsHour,
        ));
      }
    }
  }

  return {
    citySlots,
    planWeights,
    foldOrder: sorted.map(d => d.unitId),
  };
}
