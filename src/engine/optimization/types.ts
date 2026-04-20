import type { Resource } from "../../core/constants.js";

export type MobilizationConfig = {
  cities: Array<{
    cityId: string;
    roLevel: number;
    unitsAllocated: number;
  }>;
  buildingCost: number;
  buildingCostByCity?: Record<string, number>;
};

// Dynamic batch allocation supporting variable number of levels
// Maps level number to unit count at that level
export type BatchAllocation = Record<number, number>;

// Helper to create empty batch allocation
export function createEmptyBatchAllocation(): BatchAllocation {
  return {};
}

// Helper to get total units from batch allocation
export function getTotalUnitsFromBatch(batch: BatchAllocation): number {
  return Object.values(batch).reduce((sum, count) => sum + count, 0);
}

export type ResearchScheduleEntry = {
  level: number;
  startHour: number;
  endHour: number;
};

export type ResearchSchedule = ResearchScheduleEntry[];

export type CostBreakdown = {
  building: number;
  mobilization: number;
  upkeep: number;
  total: number;
  feasible: boolean;
  details?: {
    mobilizationByLevel: Record<number, number>;
    upkeepByLevel: Record<number, number>;
    buildingByCity: Record<string, number>;
  };
};

export type BatchTiming = {
  level: number;
  count: number;
  researchCompleteHour: number;
  mobilizationStartHour: number;
  mobilizationEndHour: number;
  upkeepDurationHours: number;
};

// Helper to get maximum level available for a unit
export function getMaxLevel(unitId: string, unitCatalog: UnitCatalog): number {
  const unit = unitCatalog.units[unitId];
  if (!unit) {
    throw new Error(`Unknown unit: ${unitId}`);
  }
  
  const levels = Object.keys(unit.levels).map(Number);
  if (levels.length === 0) {
    throw new Error(`Unit ${unitId} has no levels defined`);
  }
  
  return Math.max(...levels);
}

// Helper to get all available levels for a unit (sorted)
export function getAvailableLevels(unitId: string, unitCatalog: UnitCatalog): number[] {
  const unit = unitCatalog.units[unitId];
  if (!unit) {
    throw new Error(`Unknown unit: ${unitId}`);
  }
  
  return Object.keys(unit.levels).map(Number).sort((a, b) => a - b);
}

export type ResourceCost = Partial<Record<Resource, number>>;

import type { UnitCatalog } from "../../schemas/unit-schema.js";
