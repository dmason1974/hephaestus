import type { BuildingsFile } from "../../schemas/building-schema.js";
import type { UnitCatalog } from "../../schemas/unit-schema.js";
import type { BatchAllocation, MobilizationConfig, ResearchSchedule } from "./types.js";
import { calculateBuildingCost, calculateCompletionHour, resourceCostToScalar } from "./cost-calculator.js";

type GenerateMobilizationConfigsOptions = {
  buildings?: BuildingsFile;
  buildingId?: string;
  startingBuildingLevel?: number;
  /** Additional scalar cost per city (e.g. army_base build cost), applied on top of RO cost. */
  additionalCostPerCity?: number;
  /** Minimum RO level required by the unit. Configs below this level are never generated. */
  minROLevel?: number;
};

type FilterFeasibleConfigsArgs = {
  unitId: string;
  batchAllocation: BatchAllocation;
  researchSchedule: ResearchSchedule;
  deadlineHour: number;
  unitCatalog: UnitCatalog;
  buildings: BuildingsFile;
  doctrine: string;
  moralePct?: number;
};

export function generateMobilizationConfigs(
  availableCities: string[],
  maxCities: number,
  maxROLevel: number,
  unitCount: number,
  options: GenerateMobilizationConfigsOptions = {}
): MobilizationConfig[] {
  const cappedMaxCities = Math.max(0, Math.min(maxCities, availableCities.length));
  if (cappedMaxCities === 0 || unitCount <= 0) {
    return [];
  }

  const buildingId = options.buildingId ?? "recruiting_office";
  const startingBuildingLevel = options.startingBuildingLevel ?? 0;
  const minROLevel = Math.max(1, options.minROLevel ?? 1);
  const configs: MobilizationConfig[] = [];

  for (let cityCount = 1; cityCount <= cappedMaxCities; cityCount++) {
    const selectedCities = availableCities.slice(0, cityCount);
    for (let roLevel = minROLevel; roLevel <= maxROLevel; roLevel++) {
      const allocations = allocateEvenly(unitCount, cityCount);
      const buildingCostByCity: Record<string, number> = {};

      for (const cityId of selectedCities) {
        buildingCostByCity[cityId] = (options.buildings
          ? resourceCostToScalar(
              calculateBuildingCost(buildingId, startingBuildingLevel, roLevel, options.buildings)
            )
          : roLevel - startingBuildingLevel) + (options.additionalCostPerCity ?? 0);
      }

      configs.push({
        cities: selectedCities.map((cityId, index) => ({
          cityId,
          roLevel,
          unitsAllocated: allocations[index] ?? 0,
        })),
        buildingCost: Object.values(buildingCostByCity).reduce((sum, value) => sum + value, 0),
        buildingCostByCity,
      });
    }
  }

  return configs.sort(compareConfigs);
}

export function filterFeasibleConfigs(
  configs: MobilizationConfig[],
  args: FilterFeasibleConfigsArgs
): MobilizationConfig[] {
  return configs.filter(
    config =>
      calculateCompletionHour(
        args.unitId,
        config,
        args.batchAllocation,
        args.researchSchedule,
        args.unitCatalog,
        args.buildings,
        args.doctrine,
        args.moralePct
      ) <= args.deadlineHour
  );
}

function allocateEvenly(unitCount: number, cityCount: number): number[] {
  const base = Math.floor(unitCount / cityCount);
  const remainder = unitCount % cityCount;
  return Array.from({ length: cityCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

function compareConfigs(left: MobilizationConfig, right: MobilizationConfig): number {
  if (left.buildingCost !== right.buildingCost) {
    return left.buildingCost - right.buildingCost;
  }
  if (left.cities.length !== right.cities.length) {
    return left.cities.length - right.cities.length;
  }

  const leftUnits = left.cities.map(city => city.unitsAllocated).join(",");
  const rightUnits = right.cities.map(city => city.unitsAllocated).join(",");
  return leftUnits.localeCompare(rightUnits);
}
