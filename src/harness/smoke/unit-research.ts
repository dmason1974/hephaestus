import path from "node:path";

import { scenarioStartAbsoluteHour } from "../../core/time.js";
import {
  simulateUnitResearchQueue,
  simulateUnitResearchTargets,
} from "../../engine/simulation/unit-research-sim.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadUnitCatalog } from "../../scenarios/io/load-unit-catalog.js";

const scenarioId = "elite_ww3_2026";
const scenario = loadScenarioFile(scenarioId);

const fighterCatalog = loadUnitCatalog(path.resolve("data/units/fighter_units.yml"));
const seasonalCatalog = loadUnitCatalog(path.resolve("data/units/seasonal_units.yml"));

const fighterQueue = simulateUnitResearchQueue(
  fighterCatalog,
  [{ unitId: "air_superiority_fighter", targetLevel: 3 }],
  scenario
);

const seasonalQueue = simulateUnitResearchQueue(
  seasonalCatalog,
  [
    { unitId: "deployable_gear", targetLevel: 1 },
    { unitId: "elite_frigate", targetLevel: 1 },
  ],
  scenario
);

const fighterTargets = simulateUnitResearchTargets(
  fighterCatalog,
  {
    air_superiority_fighter: 3,
    fixed_wing_veteran: 2,
  },
  scenario
);

function printQueue(label: string, result: ReturnType<typeof simulateUnitResearchQueue>) {
  console.log(label);
  console.table(result.segments.map(segment => ({
    unitId: segment.unitId,
    level: segment.level,
    slot: segment.slot,
    unlockDay: segment.unlockDay,
    startAbs: segment.startAbsoluteHour,
    endAbsExclusive: segment.endAbsoluteHourExclusive,
    durationHours: segment.durationHours,
    cash: segment.cost.cash,
    supplies: segment.cost.supplies,
    rares: segment.cost.rares,
  })));
  console.log("Spend events:");
  console.table(result.spendingByAbsoluteHour.map(entry => ({
    absoluteHour: entry.absoluteHour,
    cash: entry.cost.cash,
    supplies: entry.cost.supplies,
    components: entry.cost.components,
    rares: entry.cost.rares,
    electronics: entry.cost.electronics,
    manpower: entry.cost.manpower,
  })));
  console.log("Totals:", result.totals);
}

console.log("Unit research smoke");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(
  `Scenario start: day ${scenario.start.day}, hour ${scenario.start.hour}, t0=${scenarioStartAbsoluteHour(
    scenario
  )}`
);
console.log("Assumptions:");
console.log("- two country-level research slots");
console.log("- actions are assigned in input order to the earliest free slot");
console.log("- research cost is paid at project start");
console.log("- project start cannot be earlier than unit unlock_day at hour 0");
console.log("- research durations are rounded up to whole hours for hourly economy accounting");

printQueue("Fighter queue: ASF 1 -> 3", fighterQueue);
printQueue("Seasonal queue: deployable gear 1, then elite frigate 1", seasonalQueue);
printQueue("Target plan: ASF -> 3 and FWV -> 2", fighterTargets);
