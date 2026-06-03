import path from "node:path";

import { scenarioStartAbsoluteHour } from "../../core/time.js";
import { simulateUnitResearchTargets } from "../../engine/simulation/unit-research-sim.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadUnitCatalog } from "../../scenarios/io/load-unit-catalog.js";

const scenarioId = "elite/ww3";
const scenario = loadScenarioFile(scenarioId);

const navalCatalog = loadUnitCatalog(path.resolve("data/units/naval_units.yml"));
const fighterCatalog = loadUnitCatalog(path.resolve("data/units/fighter_units.yml"));
const heaviesCatalog = loadUnitCatalog(path.resolve("data/units/heavies_units.yml"));
const officerCatalog = loadUnitCatalog(path.resolve("data/units/officer_units.yml"));
const seasonalCatalog = loadUnitCatalog(path.resolve("data/units/seasonal_units.yml"));

const mergedCatalog = {
  ...navalCatalog,
  units: {
    ...navalCatalog.units,
    ...fighterCatalog.units,
    ...heaviesCatalog.units,
    ...officerCatalog.units,
    ...seasonalCatalog.units,
  },
};

const targets = {
  elite_drone_mothership: 2,
  elite_frigate: 2,
  naval_veteran: 7,
  fixed_wing_veteran: 6,
  epic_airstrike_officer: 6,
  awacs: 6,
  air_superiority_fighter: 7,
};

const result = simulateUnitResearchTargets(
  mergedCatalog,
  targets,
  scenario
);

console.log("Elite WW3 unit research smoke");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(
  `Scenario start: day ${scenario.start.day}, hour ${scenario.start.hour}, t0=${scenarioStartAbsoluteHour(
    scenario
  )}`
);
console.log("Targets:", targets);
console.log("Assumptions:");
console.log("- two country-level research slots");
console.log("- research is scheduled as late as possible before truce end");
console.log("- scenario research unlock offset is applied");
console.log("- unit-to-unit research prerequisites are auto-included");

function mapDayForAbsoluteHour(absoluteHour: number) {
  return Math.floor(absoluteHour / 24) + 1;
}

function hourOfDayForAbsoluteHour(absoluteHour: number) {
  return (absoluteHour % 24) + 1;
}

for (const slot of [1, 2] as const) {
  console.log(`Slot ${slot}`);
  console.table(
    result.segments
      .filter(segment => segment.slot === slot)
      .map(segment => ({
        unitId: segment.unitId,
        level: segment.level,
        startDay: mapDayForAbsoluteHour(segment.startAbsoluteHour),
        startHour: hourOfDayForAbsoluteHour(segment.startAbsoluteHour),
        startAbs: segment.startAbsoluteHour,
        endDay: mapDayForAbsoluteHour(segment.endAbsoluteHourExclusive),
        endHour: hourOfDayForAbsoluteHour(segment.endAbsoluteHourExclusive),
        endAbsExclusive: segment.endAbsoluteHourExclusive,
        durationHours: segment.durationHours,
        cash: segment.cost.cash,
        supplies: segment.cost.supplies,
        rares: segment.cost.rares,
      }))
  );
}

console.log("Spend events:");
console.table(result.spendingByAbsoluteHour.map(entry => ({
  absoluteHour: entry.absoluteHour,
  cash: entry.cost.cash,
  supplies: entry.cost.supplies,
  components: entry.cost.components,
  fuel: entry.cost.fuel,
  rares: entry.cost.rares,
  electronics: entry.cost.electronics,
  manpower: entry.cost.manpower,
})));

console.log("Totals:", result.totals);
