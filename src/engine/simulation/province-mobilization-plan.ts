import type { BuildingsFile } from "../../schemas/building-schema.js";
import type { UnitCatalog } from "../../schemas/unit-schema.js";
import { durationToHours, effectiveDurationFromMorale } from "../timing/activity-duration.js";
import { requirementsToLevelMap } from "../eco/flip-point-solver.js";
import {
  calculateBuildingCost,
  calculateMobilizationCost,
  getUnitLevelData,
  sumResourceCosts,
} from "../optimization/cost-calculator.js";
import type { ResourceCost } from "../optimization/types.js";

/**
 * Province-mobilised units (commando, and any future unit gated on
 * mercenary_outpost) can only be mobilised in provinces, never cities —
 * mercenary_outpost itself can only be built in a province. Capacity is one
 * mobilisation slot per province (same rule as cities), and mercenary_outpost's
 * mobilisation_speed_bonus_pct applies country-wide once built in any single
 * province — it doesn't need to be built once per province.
 */

export function getMercenaryOutpostSpeedBonusPct(
  buildings: BuildingsFile,
  mercenaryOutpostLevel: number
): number {
  if (mercenaryOutpostLevel <= 0) return 0;
  const levelData = buildings.buildings.mercenary_outpost?.levels[
    String(mercenaryOutpostLevel) as keyof typeof buildings.buildings.mercenary_outpost.levels
  ];
  return levelData?.mobilisation_speed_bonus_pct ?? 0;
}

/**
 * A unit's `unit_limit` (per doctrine, per level — see e.g. commando/
 * elite_attack_helicopter) caps how many can be ALIVE at once until research
 * reaches that level, regardless of what level they were mobilised at. Returns
 * the sorted (level, limit) pairs actually present for this unit/doctrine; a
 * unit with no unit_limit data anywhere returns an empty array (caller treats
 * that as "uncapped — single tranche at level 1").
 */
export function getUnitLimitLevels(
  unitId: string,
  unitCatalog: UnitCatalog,
  doctrine: string
): { level: number; limit: number }[] {
  const unit = unitCatalog.units[unitId];
  if (!unit) {
    throw new Error(`Unknown unit: ${unitId}`);
  }
  const levels = Object.keys(unit.levels).map(Number).sort((a, b) => a - b);
  const result: { level: number; limit: number }[] = [];
  for (const lvl of levels) {
    const limit = unit.levels[String(lvl)]?.mobilisation[doctrine]?.unit_limit;
    if (limit !== undefined) result.push({ level: lvl, limit });
  }
  return result;
}

/**
 * Splits `count` into unit_limit-gated tranches: tranche N can only mobilise
 * once research reaches the level whose unit_limit cumulative cap it needs.
 * E.g. commando (unit_limit 5/10/15) with count=12 → [{level:1,count:5},
 * {level:2,count:5},{level:3,count:2}]. A unit with no unit_limit data at any
 * level returns a single uncapped tranche at level 1 (prior behaviour).
 */
export function computeMobilizationTranches(
  count: number,
  limitLevels: { level: number; limit: number }[]
): { level: number; count: number }[] {
  if (limitLevels.length === 0) return [{ level: 1, count }];

  const tranches: { level: number; count: number }[] = [];
  let allocated = 0;
  for (const { level, limit } of limitLevels) {
    if (allocated >= count) break;
    const trancheCount = Math.min(count, limit) - allocated;
    if (trancheCount > 0) tranches.push({ level, count: trancheCount });
    allocated = Math.min(count, limit);
  }
  // count exceeds every defined unit_limit tier — fold the remainder into the
  // last (highest-level) tranche rather than dropping it silently.
  if (allocated < count) {
    const remaining = count - allocated;
    const last = tranches[tranches.length - 1];
    if (last) {
      last.count += remaining;
    } else {
      tranches.push({ level: limitLevels[limitLevels.length - 1].level, count: remaining });
    }
  }
  return tranches;
}

export type ProvinceMobilizationTrancheResult = {
  level: number;
  count: number;
  /** Cumulative mercenary_outpost level required for this tranche's own unit level. */
  mercenaryOutpostRequiredLevel: number;
  /** Relative hour (from `startHour`) the build segment for this tranche's required
   * level starts (0 duration / equal to the completion hour if no new level was
   * built for this tranche — i.e. it reused an already-built level). */
  mercenaryOutpostStartHour: number;
  /** Cumulative mercenary_outpost completion hour (relative to `startHour`) for this tranche's required level. */
  mercenaryOutpostCompleteHour: number;
  /** The research-completion floor passed in for this tranche's level (0 if none supplied). */
  mobilisationEarliestHour: number;
  /** Relative hour (from `startHour`) this tranche's mobilisation actually begins. */
  mobStartHour: number;
  mobilizationDurationHours: number;
  /** Relative hour (from `startHour`) this tranche's mobilisation completes. */
  completionHour: number;
  mobilizationCost: ResourceCost;
};

export type ProvinceMobilizationPlan = {
  unitId: string;
  /** Highest tranche level actually mobilised at (kept for display; see `tranches` for the full breakdown). */
  level: number;
  count: number;
  provinceCount: number;
  tranches: ProvinceMobilizationTrancheResult[];
  /** Cumulative mercenary_outpost level built (= highest tranche's requirement). */
  mercenaryOutpostRequiredLevel: number;
  /** Cumulative mercenary_outpost build cost, L1 through `mercenaryOutpostRequiredLevel`. */
  mercenaryOutpostBuildCost: ResourceCost;
  /** Cumulative mercenary_outpost build hours, L1 through `mercenaryOutpostRequiredLevel`. */
  mercenaryOutpostBuildHours: number;
  /** Sum of every tranche's mobilisation cost. */
  mobilizationCost: ResourceCost;
  /** Sum of every tranche's mobilisation duration (total busy mob time, not wall-clock span). */
  mobilizationDurationHours: number;
  /** Relative hour (from `startHour`) the first tranche's mobilisation begins. */
  mobStartHour: number;
  /** Relative hour (from `startHour`) the last tranche's mobilisation completes. */
  completionHour: number;
  /** mercenary_outpost build cost + mobilisation cost (excludes upkeep — the
   * caller computes that against its own deadline/remaining-days context). */
  totalCost: ResourceCost;
};

export function planProvinceMobilization(args: {
  unitId: string;
  count: number;
  provinceCount: number;
  unitCatalog: UnitCatalog;
  buildings: BuildingsFile;
  doctrine: string;
  moralePct?: number;
  startHour?: number;
  /** Relative hour (from scenario start, same convention as `startHour`)
   * before which a given tranche's level cannot mobilise — typically that
   * level's own research completion. Building mercenary_outpost itself has no
   * research gate, so only the mobilisation phase respects this floor.
   * Keyed by tranche level; a level with no entry gets floor 0 (no gate). */
  mobilisationEarliestHourByLevel?: Record<number, number>;
}): ProvinceMobilizationPlan {
  const {
    unitId,
    count,
    provinceCount,
    unitCatalog,
    buildings,
    doctrine,
    moralePct = 90,
    startHour = 0,
    mobilisationEarliestHourByLevel = {},
  } = args;

  if (provinceCount <= 0) {
    throw new Error(`${unitId} requires province mobilisation capacity, but provinceCount is ${provinceCount}`);
  }

  const unit = unitCatalog.units[unitId];
  if (!unit) {
    throw new Error(`Unknown unit: ${unitId}`);
  }

  const limitLevels = getUnitLimitLevels(unitId, unitCatalog, doctrine);
  const rawTranches = computeMobilizationTranches(count, limitLevels);

  // mercenary_outpost is built once, incrementally — cache cumulative
  // cost/hours per level so repeated tranches at the same or lower level
  // don't re-sum from scratch.
  const outpostCumulativeHours = new Map<number, number>();
  const outpostCumulativeCost = new Map<number, ResourceCost>();
  function outpostThroughLevel(reqLevel: number): { hours: number; cost: ResourceCost } {
    if (outpostCumulativeHours.has(reqLevel)) {
      return { hours: outpostCumulativeHours.get(reqLevel)!, cost: outpostCumulativeCost.get(reqLevel)! };
    }
    let hours = 0;
    for (let lv = 1; lv <= reqLevel; lv++) {
      const levelData = buildings.buildings.mercenary_outpost?.levels[
        String(lv) as keyof typeof buildings.buildings.mercenary_outpost.levels
      ];
      hours += levelData ? durationToHours(levelData.build_time) : 0;
    }
    const cost = calculateBuildingCost("mercenary_outpost", 0, reqLevel, buildings);
    outpostCumulativeHours.set(reqLevel, hours);
    outpostCumulativeCost.set(reqLevel, cost);
    return { hours, cost };
  }

  // mercenary_outpost is built just-in-time per tranche, not all at once from
  // scenario start: each level only needs to complete before its own tranche's
  // research floor (mobilisationEarliestHourByLevel), so higher levels are
  // deferred as late as the queue (sequential build) allows — the same
  // Math.max(earliestFeasible, deadline - duration) JIT shape used elsewhere
  // in this codebase (e.g. flip-point-solver.ts). Tranches are already in
  // ascending level order (computeMobilizationTranches), so a single running
  // walk suffices.
  let prevOutpostLevel = 0;
  let prevOutpostCompleteHour = startHour;

  const tranches: ProvinceMobilizationTrancheResult[] = rawTranches.map(({ level, count: trancheCount }) => {
    const requirements = unit.levels[String(level)]?.requirements ?? [];
    const requiredLevels = requirementsToLevelMap(requirements);
    const mercenaryOutpostRequiredLevel = requiredLevels.mercenary_outpost ?? 0;
    const mobilisationEarliestHour = mobilisationEarliestHourByLevel[level] ?? 0;

    let mercenaryOutpostStartHour: number;
    let mercenaryOutpostCompleteHour: number;
    if (mercenaryOutpostRequiredLevel <= prevOutpostLevel) {
      mercenaryOutpostStartHour = prevOutpostCompleteHour;
      mercenaryOutpostCompleteHour = prevOutpostCompleteHour;
    } else {
      const incrementalHours =
        outpostThroughLevel(mercenaryOutpostRequiredLevel).hours - outpostThroughLevel(prevOutpostLevel).hours;
      mercenaryOutpostCompleteHour = Math.max(prevOutpostCompleteHour + incrementalHours, mobilisationEarliestHour);
      mercenaryOutpostStartHour = mercenaryOutpostCompleteHour - incrementalHours;
      prevOutpostLevel = mercenaryOutpostRequiredLevel;
      prevOutpostCompleteHour = mercenaryOutpostCompleteHour;
    }

    const levelData = getUnitLevelData(unitId, level, unitCatalog);
    const mobData = levelData.mobilisation[doctrine];
    if (!mobData) {
      throw new Error(`no mobilisation data for doctrine "${doctrine}" on unit ${unitId} level ${level}`);
    }
    const baseDurationHours = durationToHours(mobData.time);
    const moraleAdjustedHours = effectiveDurationFromMorale(baseDurationHours, moralePct);
    const speedBonusPct = getMercenaryOutpostSpeedBonusPct(buildings, mercenaryOutpostRequiredLevel);
    const perUnitDurationHours = moraleAdjustedHours / (1 + speedBonusPct);

    const effectiveCapacity = Math.max(1, Math.min(provinceCount, trancheCount));
    const mobilizationDurationHours = Math.ceil(Math.ceil(trancheCount / effectiveCapacity) * perUnitDurationHours);

    const mobilizationCost = calculateMobilizationCost(unitId, level, trancheCount, unitCatalog, doctrine);
    const mobStartHour = Math.max(mercenaryOutpostCompleteHour, mobilisationEarliestHour);
    const completionHour = mobStartHour + mobilizationDurationHours;

    return {
      level,
      count: trancheCount,
      mercenaryOutpostRequiredLevel,
      mercenaryOutpostStartHour,
      mercenaryOutpostCompleteHour,
      mobilisationEarliestHour,
      mobStartHour,
      mobilizationDurationHours,
      completionHour,
      mobilizationCost,
    };
  });

  const highestLevel = Math.max(...tranches.map(t => t.level));
  const { hours: mercenaryOutpostBuildHours, cost: mercenaryOutpostBuildCost } = outpostThroughLevel(
    Math.max(...tranches.map(t => t.mercenaryOutpostRequiredLevel))
  );
  const mobilizationCost = tranches.reduce(
    (acc, t) => sumResourceCosts(acc, t.mobilizationCost),
    {} as ResourceCost
  );
  const mobilizationDurationHours = tranches.reduce((acc, t) => acc + t.mobilizationDurationHours, 0);
  const mobStartHour = Math.min(...tranches.map(t => t.mobStartHour));
  const completionHour = Math.max(...tranches.map(t => t.completionHour));

  return {
    unitId,
    level: highestLevel,
    count,
    provinceCount,
    tranches,
    mercenaryOutpostRequiredLevel: Math.max(...tranches.map(t => t.mercenaryOutpostRequiredLevel)),
    mercenaryOutpostBuildCost,
    mercenaryOutpostBuildHours,
    mobilizationCost,
    mobilizationDurationHours,
    mobStartHour,
    completionHour,
    totalCost: sumResourceCosts(mercenaryOutpostBuildCost, mobilizationCost),
  };
}
