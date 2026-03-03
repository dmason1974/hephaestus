import { dayStartAbsoluteHour, scenarioStartAbsoluteHour } from "../../../core/time.js";
import { DEFAULT_MORALE_DECAY_D, HOMELAND_TARGET_MORALE, STARTING_MORALE_DAY1 } from "../../../core/constants.js";
import { buildDailyMultipliersTable } from "../../../models/economy/resource-table.js";
import { loadScenarioFile } from "../../../validation/scenarioPaths.js";

const scenarioId = "elite_ava_feb_2026";
const scenario = loadScenarioFile(scenarioId);

const t = buildDailyMultipliersTable(28, {
  startPop: 5,
  populationMode: "step",
  moraleParams: {
    S: STARTING_MORALE_DAY1,
    T: HOMELAND_TARGET_MORALE,
    N: 0,
    D: DEFAULT_MORALE_DECAY_D,
  },
});

console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(
  `Scenario start: day ${scenario.start.day}, hour ${scenario.start.hour}, t0=${scenarioStartAbsoluteHour(
    scenario
  )}`
);

console.table(
  t.rows.map(r => ({
    day: r.day,
    dayStartAbs: dayStartAbsoluteHour(scenario, r.day),
    morale: r.morale,
    moraleMul: Number(r.moraleMul.toFixed(4)),
    popDecimal: Number(r.popDecimal.toFixed(4)),
    popMul: Number(r.popMul.toFixed(4)),
  }))
);
