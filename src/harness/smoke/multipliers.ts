import { scenarioStartAbsoluteHour } from "../../core/time.js";
import { DEFAULT_MORALE_DECAY_D, HOMELAND_TARGET_MORALE, STARTING_MORALE_DAY1 } from "../../core/constants.js";
import { buildDailyMultipliersTable } from "../../engine/economy/city-production.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";

const scenarioId = "elite/antarctica";
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
    morale: r.morale,
    moraleMul: Number(r.moraleMul.toFixed(4)),
    popDecimal: Number(r.popDecimal.toFixed(1)),
    popMul: Number(r.popMul.toFixed(2)),
  }))
);
