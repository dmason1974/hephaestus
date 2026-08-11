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

export type ProvinceMobilizationPlan = {
  unitId: string;
  level: number;
  count: number;
  provinceCount: number;
  mercenaryOutpostRequiredLevel: number;
  mercenaryOutpostBuildCost: ResourceCost;
  mercenaryOutpostBuildHours: number;
  mobilizationCost: ResourceCost;
  mobilizationDurationHours: number;
  /** Relative hour (from `startHour`) this demand's mobilisation completes. */
  completionHour: number;
  /** mercenary_outpost build cost + mobilisation cost (excludes upkeep — the
   * caller computes that against its own deadline/remaining-days context). */
  totalCost: ResourceCost;
};

export function planProvinceMobilization(args: {
  unitId: string;
  level: number;
  count: number;
  provinceCount: number;
  unitCatalog: UnitCatalog;
  buildings: BuildingsFile;
  doctrine: string;
  moralePct?: number;
  startHour?: number;
}): ProvinceMobilizationPlan {
  const {
    unitId,
    level,
    count,
    provinceCount,
    unitCatalog,
    buildings,
    doctrine,
    moralePct = 90,
    startHour = 0,
  } = args;

  if (provinceCount <= 0) {
    throw new Error(`${unitId} requires province mobilisation capacity, but provinceCount is ${provinceCount}`);
  }

  const unit = unitCatalog.units[unitId];
  if (!unit) {
    throw new Error(`Unknown unit: ${unitId}`);
  }
  const requirements = unit.levels[String(level)]?.requirements ?? [];
  const requiredLevels = requirementsToLevelMap(requirements);
  const mercenaryOutpostRequiredLevel = requiredLevels.mercenary_outpost ?? 0;

  const mercenaryOutpostBuildCost = calculateBuildingCost(
    "mercenary_outpost",
    0,
    mercenaryOutpostRequiredLevel,
    buildings
  );
  let mercenaryOutpostBuildHours = 0;
  for (let lv = 1; lv <= mercenaryOutpostRequiredLevel; lv++) {
    const levelData = buildings.buildings.mercenary_outpost?.levels[
      String(lv) as keyof typeof buildings.buildings.mercenary_outpost.levels
    ];
    mercenaryOutpostBuildHours += levelData ? durationToHours(levelData.build_time) : 0;
  }
  const mercenaryOutpostCompleteHour = startHour + mercenaryOutpostBuildHours;

  const levelData = getUnitLevelData(unitId, level, unitCatalog);
  const mobData = levelData.mobilisation[doctrine];
  if (!mobData) {
    throw new Error(`no mobilisation data for doctrine "${doctrine}" on unit ${unitId} level ${level}`);
  }
  const baseDurationHours = durationToHours(mobData.time);
  const moraleAdjustedHours = effectiveDurationFromMorale(baseDurationHours, moralePct);
  const speedBonusPct = getMercenaryOutpostSpeedBonusPct(buildings, mercenaryOutpostRequiredLevel);
  const perUnitDurationHours = moraleAdjustedHours / (1 + speedBonusPct);

  const effectiveCapacity = Math.max(1, Math.min(provinceCount, count));
  const mobilizationDurationHours = Math.ceil(Math.ceil(count / effectiveCapacity) * perUnitDurationHours);

  const mobilizationCost = calculateMobilizationCost(unitId, level, count, unitCatalog, doctrine);
  const completionHour = mercenaryOutpostCompleteHour + mobilizationDurationHours;

  return {
    unitId,
    level,
    count,
    provinceCount,
    mercenaryOutpostRequiredLevel,
    mercenaryOutpostBuildCost,
    mercenaryOutpostBuildHours,
    mobilizationCost,
    mobilizationDurationHours,
    completionHour,
    totalCost: sumResourceCosts(mercenaryOutpostBuildCost, mobilizationCost),
  };
}
