import type { BuildingsFile } from "../../schemas/building-schema.js";
import type { UnitCatalog } from "../../schemas/unit-schema.js";
import type { Resource } from "../../core/constants.js";
import type {
  MobilizationConfig,
  BatchAllocation,
  ResearchSchedule,
  CostBreakdown,
  ResourceCost,
} from "./types.js";

/**
 * Calculate the mobilization cost for a specific unit at a given level
 */
export function calculateMobilizationCost(
  unitId: string,
  level: number,
  count: number,
  unitCatalog: UnitCatalog
): ResourceCost {
  const unit = unitCatalog.units[unitId];
  if (!unit) {
    throw new Error(`Unknown unit: ${unitId}`);
  }

  const levelData = unit.levels[String(level)];
  if (!levelData) {
    throw new Error(`Unknown level ${level} for unit ${unitId}`);
  }

  const cost: ResourceCost = {};
  const resources: Resource[] = [
    "supplies",
    "components",
    "fuel",
    "electronics",
    "rares",
    "cash",
    "manpower",
  ];

  for (const resource of resources) {
    const unitCost = levelData.mobilisation.cost[resource];
    if (unitCost > 0) {
      cost[resource] = unitCost * count;
    }
  }

  return cost;
}

/**
 * Calculate upkeep cost per day for a unit at a given level
 */
export function calculateDailyUpkeep(
  unitId: string,
  level: number,
  unitCatalog: UnitCatalog
): ResourceCost {
  const unit = unitCatalog.units[unitId];
  if (!unit) {
    throw new Error(`Unknown unit: ${unitId}`);
  }

  const levelData = unit.levels[String(level)];
  if (!levelData) {
    throw new Error(`Unknown level ${level} for unit ${unitId}`);
  }

  return levelData.daily_upkeep.cost;
}

/**
 * Calculate total upkeep cost over a period
 */
export function calculateUpkeepCost(
  unitId: string,
  level: number,
  count: number,
  durationHours: number,
  unitCatalog: UnitCatalog
): ResourceCost {
  const dailyUpkeep = calculateDailyUpkeep(unitId, level, unitCatalog);
  const durationDays = durationHours / 24;

  const cost: ResourceCost = {};
  for (const [resource, amount] of Object.entries(dailyUpkeep)) {
    cost[resource as Resource] = amount * count * durationDays;
  }

  return cost;
}

/**
 * Calculate the cost to upgrade a building from one level to another
 */
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
    const levelData = building.levels[String(level)];
    if (!levelData) {
      throw new Error(`Unknown level ${level} for building ${buildingId}`);
    }

    for (const [resource, amount] of Object.entries(levelData.cost)) {
      if (amount > 0) {
        totalCost[resource as Resource] = (totalCost[resource as Resource] ?? 0) + amount;
      }
    }
  }

  return totalCost;
}

/**
 * Sum multiple resource costs
 */
export function sumResourceCosts(...costs: ResourceCost[]): ResourceCost {
  const total: ResourceCost = {};

  for (const cost of costs) {
    for (const [resource, amount] of Object.entries(cost)) {
      total[resource as Resource] = (total[resource as Resource] ?? 0) + amount;
    }
  }

  return total;
}

/**
 * Convert resource cost to a single scalar value
 * Uses weighted sum based on resource rarity/importance
 */
export function resourceCostToScalar(cost: ResourceCost, weights?: Partial<Record<Resource, number>>): number {
  const defaultWeights: Record<Resource, number> = {
    supplies: 1,
    components: 1.2,
    fuel: 0.8,
    electronics: 1.5,
    rares: 2.0,
    cash: 0.5,
    manpower: 1.0,
  };

  const effectiveWeights = { ...defaultWeights, ...weights };

  let total = 0;
  for (const [resource, amount] of Object.entries(cost)) {
    const weight = effectiveWeights[resource as Resource] ?? 1;
    total += amount * weight;
  }

  return total;
}

/**
 * Calculate mobilization duration for a batch of units
 */
export function calculateMobilizationDuration(
  unitId: string,
  level: number,
  count: number,
  cityCount: number,
  roLevel: number,
  unitCatalog: UnitCatalog
): number {
  const unit = unitCatalog.units[unitId];
  if (!unit) {
    throw new Error(`Unknown unit: ${unitId}`);
  }

  const levelData = unit.levels[String(level)];
  if (!levelData) {
    throw new Error(`Unknown level ${level} for unit ${unitId}`);
  }

  // Base mobilization time
  const baseDuration =
    (levelData.mobilisation.time.days ?? 0) * 24 +
    (levelData.mobilisation.time.hours ?? 0) +
    (levelData.mobilisation.time.minutes ?? 0) / 60 +
    (levelData.mobilisation.time.seconds ?? 0) / 3600;

  // RO level reduces mobilization time
  const roSpeedBonus = getROMobilizationSpeedBonus(roLevel);
  const adjustedDuration = baseDuration * (1 - roSpeedBonus);

  // Units per city (rounded up)
  const unitsPerCity = Math.ceil(count / cityCount);

  // Total duration = units per city × adjusted duration per unit
  return Math.ceil(unitsPerCity * adjustedDuration);
}

/**
 * Get mobilization speed bonus from recruiting office level
 */
function getROMobilizationSpeedBonus(roLevel: number): number {
  const bonuses: Record<number, number> = {
    0: 0.0,
    1: 0.10,
    2: 0.25,
    3: 0.45,
    4: 0.70,
    5: 1.00,
  };

  return bonuses[roLevel] ?? 0;
}

/**
 * Calculate total cost for a mobilization configuration
 */
export function calculateTotalCost(
  unitId: string,
  config: MobilizationConfig,
  batchAllocation: BatchAllocation,
  researchSchedule: ResearchSchedule,
  deadlineHour: number,
  unitCatalog: UnitCatalog
): CostBreakdown {
  let mobilizationCost: ResourceCost = {};
  let upkeepCost: ResourceCost = {};
  let latestCompletionHour = 0;

  const mobilizationByLevel: Record<number, number> = {};
  const upkeepByLevel: Record<number, number> = {};

  // Calculate costs for each level
  for (let level = 1; level <= 5; level++) {
    const count = batchAllocation[`L${level}` as keyof BatchAllocation];
    if (count === 0) continue;

    const research = researchSchedule.find(r => r.level === level);
    if (!research) {
      return {
        building: config.buildingCost,
        mobilization: 0,
        upkeep: 0,
        total: Infinity,
        feasible: false,
      };
    }

    // Mobilization timing
    const mobilizationStart = research.endHour;
    const cityCount = config.cities.length;
    const avgROLevel = Math.round(
      config.cities.reduce((sum, c) => sum + c.roLevel, 0) / cityCount
    );

    const mobilizationDuration = calculateMobilizationDuration(
      unitId,
      level,
      count,
      cityCount,
      avgROLevel,
      unitCatalog
    );

    const mobilizationEnd = mobilizationStart + mobilizationDuration;

    // Check feasibility
    if (mobilizationEnd > deadlineHour) {
      return {
        building: config.buildingCost,
        mobilization: 0,
        upkeep: 0,
        total: Infinity,
        feasible: false,
      };
    }

    latestCompletionHour = Math.max(latestCompletionHour, mobilizationEnd);

    // Mobilization cost
    const mobCost = calculateMobilizationCost(unitId, level, count, unitCatalog);
    mobilizationCost = sumResourceCosts(mobilizationCost, mobCost);
    mobilizationByLevel[level] = resourceCostToScalar(mobCost);

    // Upkeep cost
    const upkeepDuration = deadlineHour - mobilizationEnd;
    const upCost = calculateUpkeepCost(unitId, level, count, upkeepDuration, unitCatalog);
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
      buildingByCity: config.cities.reduce((acc, city) => {
        acc[city.cityId] = 0; // Would need building costs here
        return acc;
      }, {} as Record<string, number>),
    },
  };
}