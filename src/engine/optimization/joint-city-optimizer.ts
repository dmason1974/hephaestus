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
  const avgUpkeepHours = (truceDays * 24) / 2;
  const total: Partial<Record<Resource, number>> = {};

  for (const { unitId, effectiveCount } of demands) {
    for (const cost of [
      calculateMobilizationCost(unitId, 1, effectiveCount, catalog, doctrine),
      calculateUpkeepCost(unitId, 1, effectiveCount, avgUpkeepHours, catalog, doctrine),
    ]) {
      for (const [r, v] of Object.entries(cost) as [Resource, number][]) {
        if (v > 0) total[r] = (total[r] ?? 0) + v;
      }
    }
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

function infraCompatible(primaryUnitId: string, candidateUnitId: string, catalog: UnitCatalog, buildings: BuildingsFile): boolean {
  const primReqs = getBuildingRequirements(primaryUnitId, catalog, buildings);
  const candReqs = getBuildingRequirements(candidateUnitId, catalog, buildings);
  for (const [bldgId, lvlNeeded] of candReqs) {
    if (bldgId === "recruiting_office") continue;
    if ((primReqs.get(bldgId) ?? 0) < lvlNeeded) return false;
  }
  return true;
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

    // One-pass morale iteration: estimate T from deadline morale, derive JIT mob start, refine T
    const T0 = calculateMobilizationDuration(unitId, 1, 1, 1, neededRo, catalog, buildings, doctrine, moraleAtAbsHour(slot.infraOpenHour + slot.windowHours));
    if (T0 <= 0) continue;
    const remaining = effectiveWindow - slot.usedHours;
    const nEst = Math.min(maxN, Math.floor(remaining / T0));
    if (nEst <= 0) continue;
    const absorbedInfraOpen = slot.infraOpenHour + roExtraHours;
    const jitStart = Math.max(absorbedInfraOpen, slot.infraOpenHour + slot.windowHours - slot.usedHours - nEst * T0);
    const T = calculateMobilizationDuration(unitId, 1, 1, 1, neededRo, catalog, buildings, doctrine, moraleAtAbsHour(jitStart));
    if (T <= 0) continue;

    const nAbsorbable = Math.min(maxN, Math.floor(remaining / T));
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

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Folds all demands into a city plan using the incremental heaviness-first algorithm.
 *
 * @param demands  Active demands (province and launcher-platform demands excluded).
 * @param cityIds  Available city IDs in priority order (capital first).
 * @param scenarioAbsHour  Absolute hour of game start.
 * @param deadlineAbsHour  Absolute hour of the truce deadline.
 */
export function foldInDemands(
  demands: Array<{ unitId: string; effectiveCount: number }>,
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
  const sorted = [...demands].sort(
    (a, b) =>
      infraHeaviness(b.unitId, catalog, buildings, planWeights) -
      infraHeaviness(a.unitId, catalog, buildings, planWeights),
  );

  const citySlots: CityMobSlot[] = [];
  let nextCityIdx = 0;

  for (const demand of sorted) {
    const { unitId, effectiveCount } = demand;
    const minRo = getUnitMinRo(unitId, catalog);
    let remaining = effectiveCount;

    // ── Try absorbing into existing compatible cities ──────────────────────
    const options = evaluateAbsorptionOptions(
      citySlots, unitId, remaining, minRo, catalog, buildings, doctrine, moraleAtAbsHour, planWeights, maxRoLevel,
    );

    // Sort by marginal cost per unit absorbed (most efficient absorption first)
    options.sort((a, b) => (a.marginalCost / a.nAbsorbable) - (b.marginalCost / b.nAbsorbable));

    for (const opt of options) {
      if (remaining <= 0) break;
      const n = Math.min(opt.nAbsorbable, remaining);

      // Compare: absorption cost for n vs cheapest new-city cost for n
      const remainingCities = cityIds.length - nextCityIdx;
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
      const remainingCities = cityIds.length - nextCityIdx;
      const est = estimateBestNewCityConfig(
        unitId, remaining, minRo, maxRoLevel, Math.max(1, remainingCities),
        scenarioAbsHour, deadlineAbsHour,
        catalog, buildings, doctrine, moraleAtAbsHour, planWeights,
      );
      if (!est) continue;

      const { numCities, roLevel: bestRo, unitsPerCity } = est;

      for (let ci = 0; ci < numCities && nextCityIdx < cityIds.length; ci++) {
        // Last city gets the remainder; all others get unitsPerCity
        const allocated = ci === numCities - 1
          ? remaining - unitsPerCity * (numCities - 1)
          : unitsPerCity;
        const cid = cityIds[nextCityIdx++];
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
