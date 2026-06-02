import type { UnitCatalog } from "../../schemas/unit-schema.js";
import type { BuildingsFile } from "../../schemas/building-schema.js";
import type { ScenarioFile } from "../../schemas/scenario-schema.js";
import type { Country } from "../../schemas/country-schema.js";
import { generateMobilizationConfigs, filterFeasibleConfigs } from "./mobilization-config-generator.js";
import { optimizeResearchSchedule } from "./research-schedule-optimizer.js";
import { optimizeBatchAllocation } from "./batch-allocation-optimizer.js";
import { calculateTotalCost } from "./cost-calculator.js";
import type { MobilizationConfig, BatchAllocation, ResearchSchedule, CostBreakdown } from "./types.js";

export type ForceProjectionInput = {
  unitId: string;
  unitCount: number;
  scenario: ScenarioFile;
  country: Country;
  unitCatalog: UnitCatalog;
  buildings: BuildingsFile;
  deadlineHour: number;
  maxROLevel?: number;
  moralePct?: number;
};

export type ForceProjectionSolution = {
  config: MobilizationConfig;
  researchSchedule: ResearchSchedule;
  batchAllocation: BatchAllocation;
  costBreakdown: CostBreakdown;
  maxLevelAchievable: number;
  feasible: boolean;
};

export type ForceProjectionResult = {
  bestSolution: ForceProjectionSolution | null;
  allSolutions: ForceProjectionSolution[];
  searchStats: {
    configurationsGenerated: number;
    configurationsEvaluated: number;
    feasibleSolutions: number;
    searchTimeMs: number;
  };
};

/**
 * Finds the optimal force projection plan for a single unit type.
 * 
 * Uses exhaustive search to explore all feasible combinations of:
 * - City count (1 to N)
 * - Recruiting Office levels (1 to maxROLevel)
 * - Research schedules (maximize level before deadline)
 * - Batch allocations (cost-optimal distribution)
 * 
 * Returns the solution with the lowest total cost.
 * 
 * @param input Force projection parameters
 * @returns Optimal solution and search statistics
 */
export function optimizeForceProjection(input: ForceProjectionInput): ForceProjectionResult {
  const startTime = performance.now();
  
  const {
    unitId,
    unitCount,
    scenario,
    country,
    unitCatalog,
    buildings,
    deadlineHour,
    maxROLevel = 5,
    moralePct = 90,
  } = input;

  // Extract city IDs from country
  const cityIds = country.cities.map(city => city.id);
  
  if (cityIds.length === 0) {
    return {
      bestSolution: null,
      allSolutions: [],
      searchStats: {
        configurationsGenerated: 0,
        configurationsEvaluated: 0,
        feasibleSolutions: 0,
        searchTimeMs: performance.now() - startTime,
      },
    };
  }

  // Step 1: Generate all possible city/RO configurations
  const configs = generateMobilizationConfigs(
    cityIds,
    cityIds.length, // maxCities = all available cities
    maxROLevel,
    unitCount,
    { buildings }
  );

  const configurationsGenerated = configs.length;
  const allSolutions: ForceProjectionSolution[] = [];

  // Research schedule is independent of city/RO configuration — compute once
  const researchResult = optimizeResearchSchedule({
    unitId,
    unitCatalog,
    scenario,
    deadlineHour,
  });

  if (!researchResult.feasible || researchResult.maxLevelAchievable === 0) {
    return {
      bestSolution: null,
      allSolutions: [],
      searchStats: {
        configurationsGenerated,
        configurationsEvaluated: 0,
        feasibleSolutions: 0,
        searchTimeMs: performance.now() - startTime,
      },
    };
  }

  // Step 2: For each configuration, optimize batch allocation
  for (const config of configs) {

    // Optimize batch allocation
    const batchResult = optimizeBatchAllocation({
      unitId,
      totalUnits: unitCount,
      config,
      researchSchedule: researchResult.schedule,
      deadlineHour,
      unitCatalog,
      buildings,
      moralePct,
    });

    if (!batchResult.feasible) {
      continue; // Skip if allocation not feasible
    }

    // Calculate total cost including building costs
    const costBreakdown = calculateTotalCost(
      unitId,
      config,
      batchResult.allocation,
      researchResult.schedule,
      deadlineHour,
      unitCatalog,
      buildings,
      moralePct
    );

    if (!costBreakdown.feasible) {
      continue; // Skip if mobilization doesn't meet deadline
    }

    allSolutions.push({
      config,
      researchSchedule: researchResult.schedule,
      batchAllocation: batchResult.allocation,
      costBreakdown,
      maxLevelAchievable: researchResult.maxLevelAchievable,
      feasible: true,
    });
  }

  // Step 3: Find the best solution (lowest total cost)
  const bestSolution = allSolutions.length > 0
    ? allSolutions.reduce((best, current) =>
        current.costBreakdown.total < best.costBreakdown.total ? current : best
      )
    : null;

  const endTime = performance.now();

  return {
    bestSolution,
    allSolutions: allSolutions.sort((a, b) => a.costBreakdown.total - b.costBreakdown.total),
    searchStats: {
      configurationsGenerated,
      configurationsEvaluated: configs.length,
      feasibleSolutions: allSolutions.length,
      searchTimeMs: endTime - startTime,
    },
  };
}

/**
 * Formats a force projection solution for display.
 * 
 * @param solution Solution to format
 * @returns Human-readable summary
 */
export function formatSolution(solution: ForceProjectionSolution): string {
  const lines: string[] = [];
  
  lines.push("=== Force Projection Solution ===");
  lines.push("");
  
  // Configuration
  lines.push("Configuration:");
  lines.push(`  Cities: ${solution.config.cities.length}`);
  for (const city of solution.config.cities) {
    lines.push(`    - ${city.cityId}: RO Level ${city.roLevel}, ${city.unitsAllocated} units`);
  }
  lines.push("");
  
  // Research Schedule
  lines.push("Research Schedule:");
  lines.push(`  Max Level: ${solution.maxLevelAchievable}`);
  for (const entry of solution.researchSchedule) {
    lines.push(`    - Level ${entry.level}: hours ${entry.startHour}-${entry.endHour}`);
  }
  lines.push("");
  
  // Batch Allocation
  lines.push("Unit Distribution:");
  for (const [level, count] of Object.entries(solution.batchAllocation)) {
    if (count > 0) {
      lines.push(`    - Level ${level}: ${count} units`);
    }
  }
  lines.push("");
  
  // Costs
  lines.push("Cost Breakdown:");
  lines.push(`  Building:     ${solution.costBreakdown.building.toFixed(2)}`);
  lines.push(`  Mobilization: ${solution.costBreakdown.mobilization.toFixed(2)}`);
  lines.push(`  Upkeep:       ${solution.costBreakdown.upkeep.toFixed(2)}`);
  lines.push(`  TOTAL:        ${solution.costBreakdown.total.toFixed(2)}`);
  
  return lines.join("\n");
}

/**
 * Formats search statistics for display.
 * 
 * @param result Optimization result
 * @returns Human-readable summary
 */
export function formatSearchStats(result: ForceProjectionResult): string {
  const lines: string[] = [];
  
  lines.push("=== Search Statistics ===");
  lines.push(`Configurations Generated: ${result.searchStats.configurationsGenerated}`);
  lines.push(`Configurations Evaluated: ${result.searchStats.configurationsEvaluated}`);
  lines.push(`Feasible Solutions:       ${result.searchStats.feasibleSolutions}`);
  lines.push(`Search Time:              ${result.searchStats.searchTimeMs.toFixed(2)}ms`);
  
  if (result.bestSolution) {
    lines.push("");
    lines.push(`Best Solution Cost:       ${result.bestSolution.costBreakdown.total.toFixed(2)}`);
    lines.push(`Cities Used:              ${result.bestSolution.config.cities.length}`);
    lines.push(`Max Level Achieved:       ${result.bestSolution.maxLevelAchievable}`);
  }
  
  return lines.join("\n");
}

// Made with Bob
