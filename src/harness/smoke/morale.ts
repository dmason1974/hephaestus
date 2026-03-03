import { scenarioStartAbsoluteHour } from "../../core/time.js";
import { baselineHomelandMoraleOnDay } from "../../engine/economy/morale.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { hourOfMapDay, mapDayForAbsoluteHour, scenarioReportWindow } from "../../engine/reporting/scenario-reporting.js";

const scenarioId = "elite_ava_feb_2026";
const scenario = loadScenarioFile(scenarioId);
const mapDaysToReport = 30;
const reportWindow = scenarioReportWindow(scenario, mapDaysToReport);

console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(
  `Scenario start: day ${scenario.start.day}, hour ${scenario.start.hour}, t0=${scenarioStartAbsoluteHour(
    scenario
  )}`
);

console.table(
  Array.from({ length: reportWindow.endAbsExclusive - reportWindow.startAbs }, (_, index) => {
    const hour = reportWindow.startAbs + index;
    const day = mapDayForAbsoluteHour(hour);

    return {
      day,
      hourOfDay: hourOfMapDay(hour),
      morale: Number(baselineHomelandMoraleOnDay(day).toFixed(4)),
    };
  })
);
