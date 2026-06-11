import type { UnitCatalog } from "../../schemas/unit-schema.js";
import type { BuildingsFile } from "../../schemas/building-schema.js";
import { getAvailableLevels, createEmptyBatchAllocation, getTotalUnitsFromBatch } from "./types.js";
import type { BatchAllocation, MobilizationConfig, ResearchSchedule } from "./types.js";
import { calculateMobilizationCost, resourceCostToScalar, calculateCompletionHour, calculateTriangularUpkeepForConfig } from "./cost-calculator.js";

export type BatchAllocationInput = {
  unitId: string;
  totalUnits: number;
  config: MobilizationConfig;
  researchSchedule: ResearchSchedule;
  deadlineHour: number;
  unitCatalog: UnitCatalog;
  buildings: BuildingsFile;
  doctrine: string;
  moralePct?: number;
};

export type BatchAllocationResult = {
  allocation: BatchAllocation;
  totalCost: number;
  feasible: boolean;
  costBreakdown: {
    mobilizationByLevel: Record<number, number>;
    upkeepByLevel: Record<number, number>;
  };
};

/**
 * Optimizes the distribution of units across available levels to minimize total cost.
 * 
 * Strategy:
 * - Greedy allocation: prioritize lower levels (cheaper mobilization + longer upkeep)
 * - Balance mobilization cost vs upkeep cost based on time until deadline
 * - Respect research schedule (only allocate to researched levels)
 * 
 * Cost model:
 * - Lower levels: cheaper mobilization, but longer upkeep (mobilized earlier)
 * - Higher levels: expensive mobilization, but shorter upkeep (mobilized later)
 * 
 * @param input Batch allocation parameters
 * @returns Optimized unit distribution across levels
 */
export function optimizeBatchAllocation(input: BatchAllocationInput): BatchAllocationResult {
  const {
    unitId,
    totalUnits,
    config,
    researchSchedule,
    deadlineHour,
    unitCatalog,
    buildings,
    doctrine,
    moralePct = 90,
  } = input;

  const unit = unitCatalog.units[unitId];
  if (!unit) {
    throw new Error(`Unknown unit: ${unitId}`);
  }

  // Get levels that have been researched
  const researchedLevels = researchSchedule.map(entry => entry.level).sort((a, b) => a - b);
  
  if (researchedLevels.length === 0) {
    return {
      allocation: createEmptyBatchAllocation(),
      totalCost: Number.POSITIVE_INFINITY,
      feasible: false,
      costBreakdown: {
        mobilizationByLevel: {},
        upkeepByLevel: {},
      },
    };
  }

  // Calculate cost per unit for each level (mobilization + upkeep until deadline).
  // Only include levels whose mobilization can complete before the deadline.
  const levelCosts: Array<{ level: number; costPerUnit: number; researchEndHour: number }> = [];

  for (const level of researchedLevels) {
    const research = researchSchedule.find(r => r.level === level);
    if (!research) continue;

    // Feasibility: all totalUnits must complete mob by deadline
    const completionHour = calculateCompletionHour(
      unitId, config, { [level]: totalUnits }, researchSchedule, unitCatalog, buildings, doctrine, moralePct
    );
    if (completionHour > deadlineHour) continue;

    const mobCost = calculateMobilizationCost(unitId, level, 1, unitCatalog, doctrine);
    const mobScalar = resourceCostToScalar(mobCost);

    // Triangular upkeep: units mobilise sequentially, paying upkeep from when each finishes.
    // Per-unit cost = totalTriangularUpkeep / totalUnits.
    const triangularUpkeep = calculateTriangularUpkeepForConfig(
      unitId, level, totalUnits, config, research.endHour, deadlineHour, unitCatalog, buildings, doctrine, moralePct
    );
    const upkeepScalar = resourceCostToScalar(triangularUpkeep);

    levelCosts.push({
      level,
      costPerUnit: mobScalar + upkeepScalar / totalUnits,
      researchEndHour: research.endHour,
    });
  }

  // Sort by cost per unit (ascending - cheapest first)
  levelCosts.sort((a, b) => a.costPerUnit - b.costPerUnit);

  // Greedy allocation: fill from cheapest to most expensive
  const allocation = createEmptyBatchAllocation();
  let remainingUnits = totalUnits;

  for (const { level } of levelCosts) {
    if (remainingUnits <= 0) break;

    // Allocate all remaining units to this level
    allocation[level] = remainingUnits;
    remainingUnits = 0;
  }

  // Calculate total cost and breakdown
  const mobilizationByLevel: Record<number, number> = {};
  const upkeepByLevel: Record<number, number> = {};
  let totalCost = 0;

  for (const level of researchedLevels) {
    const count = allocation[level] ?? 0;
    if (count <= 0) continue;

    const research = researchSchedule.find(r => r.level === level);
    if (!research) continue;

    const mobCost = calculateMobilizationCost(unitId, level, count, unitCatalog, doctrine);
    const mobScalar = resourceCostToScalar(mobCost);
    mobilizationByLevel[level] = mobScalar;

    const upkeepCost = calculateTriangularUpkeepForConfig(
      unitId, level, count, config, research.endHour, deadlineHour, unitCatalog, buildings, doctrine, moralePct
    );
    const upkeepScalar = resourceCostToScalar(upkeepCost);
    upkeepByLevel[level] = upkeepScalar;

    totalCost += mobScalar + upkeepScalar;
  }

  return {
    allocation,
    totalCost,
    feasible: getTotalUnitsFromBatch(allocation) === totalUnits,
    costBreakdown: {
      mobilizationByLevel,
      upkeepByLevel,
    },
  };
}

/**
 * Validates that a batch allocation is feasible and matches the required unit count.
 * 
 * @param allocation Batch allocation to validate
 * @param totalUnits Required total unit count
 * @param researchSchedule Research schedule (defines available levels)
 * @returns True if allocation is valid
 */
export function validateBatchAllocation(
  allocation: BatchAllocation,
  totalUnits: number,
  researchSchedule: ResearchSchedule
): boolean {
  // Check total matches
  const allocatedTotal = getTotalUnitsFromBatch(allocation);
  if (allocatedTotal !== totalUnits) {
    return false;
  }

  // Check only researched levels are used
  const researchedLevels = new Set(researchSchedule.map(r => r.level));
  for (const [levelStr, count] of Object.entries(allocation)) {
    const level = Number(levelStr);
    if (count > 0 && !researchedLevels.has(level)) {
      return false;
    }
  }

  return true;
}

/**
 * Generates alternative batch allocations for exploration.
 * Useful for comparing different distribution strategies.
 * 
 * @param input Batch allocation parameters
 * @returns Array of alternative allocations
 */
export function generateAlternativeBatchAllocations(
  input: BatchAllocationInput
): BatchAllocationResult[] {
  const { totalUnits, researchSchedule } = input;
  
  const researchedLevels = researchSchedule.map(entry => entry.level).sort((a, b) => a - b);
  
  if (researchedLevels.length === 0) {
    return [];
  }

  const alternatives: BatchAllocationResult[] = [];

  // Strategy 1: All units at lowest level
  if (researchedLevels.length > 0) {
    const allocation = createEmptyBatchAllocation();
    allocation[researchedLevels[0]] = totalUnits;
    alternatives.push(evaluateAllocation({ ...input, allocation }));
  }

  // Strategy 2: All units at highest level
  if (researchedLevels.length > 0) {
    const allocation = createEmptyBatchAllocation();
    allocation[researchedLevels[researchedLevels.length - 1]] = totalUnits;
    alternatives.push(evaluateAllocation({ ...input, allocation }));
  }

  // Strategy 3: Even split across all levels
  if (researchedLevels.length > 1) {
    const allocation = createEmptyBatchAllocation();
    const unitsPerLevel = Math.floor(totalUnits / researchedLevels.length);
    let remaining = totalUnits;

    for (let i = 0; i < researchedLevels.length; i++) {
      const level = researchedLevels[i];
      const count = i === researchedLevels.length - 1 ? remaining : unitsPerLevel;
      allocation[level] = count;
      remaining -= count;
    }

    alternatives.push(evaluateAllocation({ ...input, allocation }));
  }

  // Strategy 4: Optimized (greedy by cost)
  alternatives.push(optimizeBatchAllocation(input));

  return alternatives;
}

function evaluateAllocation(
  input: BatchAllocationInput & { allocation: BatchAllocation }
): BatchAllocationResult {
  const {
    unitId,
    allocation,
    config,
    researchSchedule,
    deadlineHour,
    unitCatalog,
    buildings,
    doctrine,
    moralePct = 90,
  } = input;

  const mobilizationByLevel: Record<number, number> = {};
  const upkeepByLevel: Record<number, number> = {};
  let totalCost = 0;
  let feasible = true;

  for (const [levelStr, count] of Object.entries(allocation)) {
    const level = Number(levelStr);
    if (count <= 0) continue;

    const research = researchSchedule.find(r => r.level === level);
    if (!research) {
      feasible = false;
      continue;
    }

    const completionHour = calculateCompletionHour(
      unitId, config, { [level]: count }, researchSchedule, unitCatalog, buildings, doctrine, moralePct
    );
    if (completionHour > deadlineHour) {
      feasible = false;
    }

    const mobCost = calculateMobilizationCost(unitId, level, count, unitCatalog, doctrine);
    const mobScalar = resourceCostToScalar(mobCost);
    mobilizationByLevel[level] = mobScalar;

    const upkeepCost = calculateTriangularUpkeepForConfig(
      unitId, level, count, config, research.endHour, deadlineHour, unitCatalog, buildings, doctrine, moralePct
    );
    const upkeepScalar = resourceCostToScalar(upkeepCost);
    upkeepByLevel[level] = upkeepScalar;

    totalCost += mobScalar + upkeepScalar;
  }

  return {
    allocation,
    totalCost,
    feasible,
    costBreakdown: {
      mobilizationByLevel,
      upkeepByLevel,
    },
  };
}

// Made with Bob
