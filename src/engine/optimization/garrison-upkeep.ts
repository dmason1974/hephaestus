import type { ScenarioFile } from "../../schemas/scenario-schema.js";
import type { UnitCatalog } from "../../schemas/unit-schema.js";
import { calculateDailyUpkeep, scaleResourceCost } from "./cost-calculator.js";
import type { ResourceCost } from "./types.js";

export type GarrisonUnitUpkeep = {
  unitId: string;
  count: number;
  dailyUpkeepPerUnit: ResourceCost;
  totalUpkeep: ResourceCost;
};

export type GarrisonUpkeepResult = {
  hours: number;
  units: GarrisonUnitUpkeep[];
  totalUpkeep: ResourceCost;
};

function addInto(target: ResourceCost, src: ResourceCost): void {
  for (const [resource, amount] of Object.entries(src)) {
    if (!amount) continue;
    target[resource as keyof ResourceCost] = (target[resource as keyof ResourceCost] ?? 0) + amount;
  }
}

/**
 * Daily upkeep for a catalog unit, falling back to whichever doctrine the catalog
 * does have data for when the requested one is missing (e.g. motorized_infantry is
 * Western-only pending screenshots — CLAUDE.md documents using it as a Western-values
 * placeholder for all doctrines in starting-garrison upkeep calcs specifically).
 */
function catalogDailyUpkeepWithFallback(unitId: string, level: number, catalog: UnitCatalog, doctrine: string): ResourceCost {
  try {
    return calculateDailyUpkeep(unitId, level, catalog, doctrine);
  } catch {
    const upkeepByDoctrine = catalog.units[unitId]?.levels?.[String(level)]?.daily_upkeep as Record<string, { cost: ResourceCost } | undefined> | undefined;
    const fallback = upkeepByDoctrine ? Object.values(upkeepByDoctrine).find(Boolean) : undefined;
    if (!fallback) throw new Error(`no daily_upkeep data for any doctrine on unit ${unitId} level ${level}`);
    return fallback.cost;
  }
}

/**
 * Upkeep cost of a homeland country's starting garrison (scenario.starting_units)
 * from scenarioAbsHour to disbandAbsHour. Catalog units resolve daily upkeep via
 * calculateDailyUpkeep (falling back to another doctrine's data if the requested one
 * is missing); units carrying an inline daily_upkeep (e.g. gunship, which isn't in the
 * unit catalog) use that instead, keyed by doctrine with the same fallback.
 */
export function computeGarrisonUpkeep(
  scenario: ScenarioFile,
  catalog: UnitCatalog,
  doctrine: string,
  scenarioAbsHour: number,
  disbandAbsHour: number
): GarrisonUpkeepResult {
  const hours = Math.max(0, disbandAbsHour - scenarioAbsHour);
  const units: GarrisonUnitUpkeep[] = [];
  const totalUpkeep: ResourceCost = {};

  for (const startingUnit of scenario.starting_units ?? []) {
    const dailyUpkeepPerUnit: ResourceCost = startingUnit.daily_upkeep
      ? (startingUnit.daily_upkeep[doctrine] ?? Object.values(startingUnit.daily_upkeep)[0] ?? {})
      : catalogDailyUpkeepWithFallback(startingUnit.unit_id, startingUnit.level, catalog, doctrine);

    const unitTotal = scaleResourceCost(dailyUpkeepPerUnit, startingUnit.count * (hours / 24));
    units.push({
      unitId: startingUnit.unit_id,
      count: startingUnit.count,
      dailyUpkeepPerUnit,
      totalUpkeep: unitTotal,
    });
    addInto(totalUpkeep, unitTotal);
  }

  return { hours, units, totalUpkeep };
}
