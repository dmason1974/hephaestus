import type { BuildingsFile } from "../../schemas/building-schema.js";
import type { UnitCatalog } from "../../schemas/unit-schema.js";
import type { Resource } from "../../core/constants.js";
import { effectiveDurationFromMorale, durationToHours } from "../timing/activity-duration.js";
import type {
  MobilizationConfig,
  BatchAllocation,
  ResearchSchedule,
  CostBreakdown,
  ResourceCost,
} from "./types.js";
import { getAvailableLevels, getTotalUnitsFromBatch } from "./types.js";

const RESOURCE_KEYS: Resource[] = [
  "supplies",
  "components",
  "fuel",
  "electronics",
  "rares",
  "cash",
  "manpower",
];

export function calculateMobilizationCost(
  unitId: string,
  level: number,
  count: number,
  unitCatalog: UnitCatalog,
  doctrine: string
): ResourceCost {
  const levelData = getUnitLevelData(unitId, level, unitCatalog);
  const mobData = levelData.mobilisation[doctrine];
  if (!mobData) throw new Error(`no mobilisation data for doctrine "${doctrine}" on unit ${unitId} level ${level}`);
  return scaleResourceCost(mobData.cost, count);
}

export function calculateDailyUpkeep(
  unitId: string,
  level: number,
  unitCatalog: UnitCatalog,
  doctrine: string
): ResourceCost {
  const levelData = getUnitLevelData(unitId, level, unitCatalog);
  const upkeepData = levelData.daily_upkeep[doctrine];
  if (!upkeepData) throw new Error(`no daily_upkeep data for doctrine "${doctrine}" on unit ${unitId} level ${level}`);
  return { ...upkeepData.cost };
}

export function calculateUpkeepCost(
  unitId: string,
  level: number,
  count: number,
  durationHours: number,
  unitCatalog: UnitCatalog,
  doctrine: string
): ResourceCost {
  return scaleResourceCost(calculateDailyUpkeep(unitId, level, unitCatalog, doctrine), count * (durationHours / 24));
}

export function calculateBuildingCost(
  buildingId: string,
  fromLevel: number,
  toLevel: number,
  buildings: BuildingsFile
): ResourceCost {
  if (toLevel <= fromLevel) {
    return {};
  }

  const building = buildings.buildings[buildingId];
  if (!building) {
    throw new Error(`Unknown building: ${buildingId}`);
  }

  const totalCost: ResourceCost = {};
  for (let level = fromLevel + 1; level <= toLevel; level++) {
    const levelKey = String(level) as keyof typeof building.levels;
    const levelData = building.levels[levelKey];
    if (!levelData) {
      throw new Error(`Unknown level ${level} for building ${buildingId}`);
    }
    mergeResourceCostInto(totalCost, levelData.cost);
  }

  return totalCost;
}

export function sumResourceCosts(...costs: ResourceCost[]): ResourceCost {
  const total: ResourceCost = {};
  for (const cost of costs) {
    mergeResourceCostInto(total, cost);
  }
  return total;
}

export function resourceCostToScalar(cost: ResourceCost, weights?: Partial<Record<Resource, number>>): number {
  // Default weights based on resource priority:
  // Electronics (highest) > Supplies > Rares > Components > Manpower > Fuel > Cash (lowest)
  const defaultWeights: Record<Resource, number> = {
    electronics: 3.0,   // Highest priority - most scarce/valuable
    supplies: 2.0,      // Second priority - commonly needed
    rares: 1.5,         // Third priority - moderately scarce
    components: 1.2,    // Medium priority
    manpower: 1.0,      // Standard priority
    fuel: 0.8,          // Lower priority
    cash: 0.5,          // Lowest priority - most abundant
  };

  const effectiveWeights = { ...defaultWeights, ...weights };

  let total = 0;
  for (const [resource, amount] of Object.entries(cost)) {
    const weight = effectiveWeights[resource as Resource] ?? 1;
    total += amount * weight;
  }

  return total;
}

export function calculateMobilizationDuration(
  unitId: string,
  level: number,
  count: number,
  cityCount: number,
  roLevel: number,
  unitCatalog: UnitCatalog,
  buildings: BuildingsFile,
  doctrine: string,
  moralePct = 90
): number {
  const levelData = getUnitLevelData(unitId, level, unitCatalog);
  const mobData = levelData.mobilisation[doctrine];
  if (!mobData) throw new Error(`no mobilisation data for doctrine "${doctrine}" on unit ${unitId} level ${level}`);
  const baseDurationHours = durationToHours(mobData.time);
  const moraleAdjustedHours = effectiveDurationFromMorale(baseDurationHours, moralePct);
  const bonusPct = getRecruitingOfficeSpeedBonusPct(buildings, roLevel);
  const adjustedDurationHours = moraleAdjustedHours / (1 + bonusPct);
  return Math.ceil(Math.ceil(count / cityCount) * adjustedDurationHours);
}

export function calculateCompletionHour(
  unitId: string,
  config: MobilizationConfig,
  batchAllocation: BatchAllocation,
  researchSchedule: ResearchSchedule,
  unitCatalog: UnitCatalog,
  buildings: BuildingsFile,
  doctrine: string,
  moralePct = 90
): number {
  let latestCompletionHour = 0;

  const availableLevels = getAvailableLevels(unitId, unitCatalog);

  for (const level of availableLevels) {
    const count = batchAllocation[level] ?? 0;
    if (count <= 0) {
      continue;
    }

    const research = researchSchedule.find(entry => entry.level === level);
    if (!research) {
      return Number.POSITIVE_INFINITY;
    }

    const completionHour = research.endHour + estimateLevelMobilizationDuration(
      unitId,
      level,
      count,
      config,
      unitCatalog,
      buildings,
      doctrine,
      moralePct
    );
    latestCompletionHour = Math.max(latestCompletionHour, completionHour);
  }

  return latestCompletionHour;
}

export function calculateTotalCost(
  unitId: string,
  config: MobilizationConfig,
  batchAllocation: BatchAllocation,
  researchSchedule: ResearchSchedule,
  deadlineHour: number,
  unitCatalog: UnitCatalog,
  buildings: BuildingsFile,
  doctrine: string,
  moralePct = 90
): CostBreakdown {
  let mobilizationCost: ResourceCost = {};
  let upkeepCost: ResourceCost = {};
  const mobilizationByLevel: Record<number, number> = {};
  const upkeepByLevel: Record<number, number> = {};

  const availableLevels = getAvailableLevels(unitId, unitCatalog);

  for (const level of availableLevels) {
    const count = batchAllocation[level] ?? 0;
    if (count <= 0) {
      continue;
    }

    const research = researchSchedule.find(r => r.level === level);
    if (!research) {
      return infeasibleCostBreakdown(config);
    }

    const mobilizationDuration = estimateLevelMobilizationDuration(
      unitId,
      level,
      count,
      config,
      unitCatalog,
      buildings,
      doctrine,
      moralePct
    );
    const mobilizationEnd = research.endHour + mobilizationDuration;
    if (mobilizationEnd > deadlineHour) {
      return infeasibleCostBreakdown(config);
    }

    const mobCost = calculateMobilizationCost(unitId, level, count, unitCatalog, doctrine);
    mobilizationCost = sumResourceCosts(mobilizationCost, mobCost);
    mobilizationByLevel[level] = resourceCostToScalar(mobCost);

    const upkeepDuration = deadlineHour - mobilizationEnd;
    const upCost = calculateUpkeepCost(unitId, level, count, upkeepDuration, unitCatalog, doctrine);
    upkeepCost = sumResourceCosts(upkeepCost, upCost);
    upkeepByLevel[level] = resourceCostToScalar(upCost);
  }

  const buildingScalar = config.buildingCost;
  const mobilizationScalar = resourceCostToScalar(mobilizationCost);
  const upkeepScalar = resourceCostToScalar(upkeepCost);

  return {
    building: buildingScalar,
    mobilization: mobilizationScalar,
    upkeep: upkeepScalar,
    total: buildingScalar + mobilizationScalar + upkeepScalar,
    feasible: true,
    details: {
      mobilizationByLevel,
      upkeepByLevel,
      buildingByCity:
        config.buildingCostByCity ??
        config.cities.reduce(
          (acc, city) => {
            acc[city.cityId] = 0;
            return acc;
          },
          {} as Record<string, number>
        ),
    },
  };
}

function getUnitLevelData(unitId: string, level: number, unitCatalog: UnitCatalog) {
  const unit = unitCatalog.units[unitId];
  if (!unit) {
    throw new Error(`Unknown unit: ${unitId}`);
  }

  const levelData = unit.levels[String(level)];
  if (!levelData) {
    throw new Error(`Unknown level ${level} for unit ${unitId}`);
  }

  return levelData;
}

function mergeResourceCostInto(target: ResourceCost, cost: ResourceCost) {
  for (const resource of RESOURCE_KEYS) {
    const amount = cost[resource];
    if (amount) {
      target[resource] = (target[resource] ?? 0) + amount;
    }
  }
}

function scaleResourceCost(cost: ResourceCost, scale: number): ResourceCost {
  const scaled: ResourceCost = {};
  for (const resource of RESOURCE_KEYS) {
    const amount = cost[resource];
    if (amount) {
      scaled[resource] = amount * scale;
    }
  }
  return scaled;
}


function getRecruitingOfficeSpeedBonusPct(buildings: BuildingsFile, roLevel: number): number {
  if (roLevel <= 0) {
    return 0;
  }

  const levelData = buildings.buildings.recruiting_office?.levels[
    String(roLevel) as keyof typeof buildings.buildings.recruiting_office.levels
  ];
  return levelData?.mobilisation_speed_bonus_pct ?? 0;
}

function apportionUnits(totalCount: number, config: MobilizationConfig): number[] {
  const requestedAllocations = config.cities.map(city => Math.max(0, city.unitsAllocated));
  const requestedTotal = requestedAllocations.reduce((sum, value) => sum + value, 0);
  if (requestedTotal <= 0) {
    return evenSplit(totalCount, config.cities.length);
  }

  const baseAllocations = requestedAllocations.map(value => Math.floor((totalCount * value) / requestedTotal));
  let assigned = baseAllocations.reduce((sum, value) => sum + value, 0);

  const rankedIndexes = requestedAllocations
    .map((value, index) => ({
      index,
      remainder: (totalCount * value) / requestedTotal - baseAllocations[index],
    }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);

  for (const { index } of rankedIndexes) {
    if (assigned >= totalCount) {
      break;
    }
    baseAllocations[index] += 1;
    assigned += 1;
  }

  return baseAllocations;
}

function evenSplit(totalCount: number, cityCount: number): number[] {
  if (cityCount <= 0) {
    return [];
  }

  const base = Math.floor(totalCount / cityCount);
  const remainder = totalCount % cityCount;
  return Array.from({ length: cityCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

function estimateLevelMobilizationDuration(
  unitId: string,
  level: number,
  count: number,
  config: MobilizationConfig,
  unitCatalog: UnitCatalog,
  buildings: BuildingsFile,
  doctrine: string,
  moralePct: number
): number {
  if (config.cities.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  const levelData = getUnitLevelData(unitId, level, unitCatalog);
  const mobData = levelData.mobilisation[doctrine];
  if (!mobData) throw new Error(`no mobilisation data for doctrine "${doctrine}" on unit ${unitId} level ${level}`);
  const baseDurationHours = durationToHours(mobData.time);
  const unitsPerCity = apportionUnits(count, config);

  return config.cities.reduce((maxDuration, city, index) => {
    const moraleAdjustedHours = effectiveDurationFromMorale(baseDurationHours, moralePct);
    const bonusPct = getRecruitingOfficeSpeedBonusPct(buildings, city.roLevel);
    const perUnitHours = moraleAdjustedHours / (1 + bonusPct);
    const cityDuration = Math.ceil((unitsPerCity[index] ?? 0) * perUnitHours);
    return Math.max(maxDuration, cityDuration);
  }, 0);
}

function infeasibleCostBreakdown(config: MobilizationConfig): CostBreakdown {
  return {
    building: config.buildingCost,
    mobilization: 0,
    upkeep: 0,
    total: Number.POSITIVE_INFINITY,
    feasible: false,
  };
}
