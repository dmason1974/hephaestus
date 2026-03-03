import { dayStartAbsoluteHour, scenarioStartAbsoluteHour } from "../../../core/time.js";
import { baselineHomelandMoraleOnDay } from "../../../models/morale/morale-baseline.js";
import { loadScenarioFile } from "../../../validation/scenarioPaths.js";

const scenarioId = "elite_ava_feb_2026";
const scenario = loadScenarioFile(scenarioId);

console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(
  `Scenario start: day ${scenario.start.day}, hour ${scenario.start.hour}, t0=${scenarioStartAbsoluteHour(
    scenario
  )}`
);

for (let d = 1; d <= 30; d++) {
  console.log(
    d,
    `dayStartAbs=${dayStartAbsoluteHour(scenario, d)}`,
    baselineHomelandMoraleOnDay(d).toFixed(4)
  );
}
