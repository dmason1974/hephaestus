import type { Resource } from "../../core/constants.js";

/**
 * Configuration for mobilization across multiple cities
 */
export type MobilizationConfig = {
  cities: Array<{
    cityId: string;
    roLevel: number;
    unitsAllocated: number;
  }>;
  buildingCost: number;
};

/**
 * Allocation of units across research levels
 */
export type BatchAllocation = {
  L1: number;
  L2: number;
  L3: number;
  L4: number;
  L5: number;
};

/**
 * Research schedule timing
 */
export type ResearchSchedule = Array<{
  level: number;
  startHour: number;
  endHour: number;
}>;

/**
 * Cost breakdown for a mobilization plan
 */
export type CostBreakdown = {
  building: number; // Cost to build/upgrade infrastructure
  mobilization: number; // Cost to mobilize all units
  upkeep: number; // Cost of unit upkeep until deadline
  total: number; // Sum of all costs
  feasible: boolean; // Whether plan can meet deadline
  details?: {
    mobilizationByLevel: Record<number, number>;
    upkeepByLevel: Record<number, number>;
    buildingByCity: Record<string, number>;
  };
};

/**
 * Mobilization timing for a batch
 */
export type BatchTiming = {
  level: number;
  count: number;
  researchCompleteHour: number;
  mobilizationStartHour: number;
  mobilizationEndHour: number;
  upkeepDurationHours: number;
};

/**
 * Resource cost for an operation
 */
export type ResourceCost = Partial<Record<Resource, number>>;