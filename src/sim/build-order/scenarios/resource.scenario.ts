import { scenarioStartAbsoluteHour } from "../../../core/time.js";
import { buildHourlyResourceTable } from "../../../models/economy/resource-table.js";
import {
  DEFAULT_MORALE_DECAY_D,
  HOMELAND_TARGET_MORALE,
  STARTING_MORALE_DAY1,
  type Resource,
} from "../../../core/constants.js";
import { loadScenarioFile } from "../../../validation/scenarioPaths.js";
import { aggregateHourlyAmountsByMapDay, scenarioReportWindow } from "./scenario-reporting.js";

const scenarioId = "elite_ava_feb_2026";
const scenario = loadScenarioFile(scenarioId);
const cityResource: Resource = "supplies";
const mapDaysToReport = 28;

const cityInputs = {
  startPop: 5 as const,
  ecoInfraMultiplier: 1.0,
  moraleParams: {
    S: STARTING_MORALE_DAY1,
    T: HOMELAND_TARGET_MORALE,
    N: 0,
    D: DEFAULT_MORALE_DECAY_D,
  },
};

const reportWindow = scenarioReportWindow(scenario, mapDaysToReport);

const resourceTable = buildHourlyResourceTable(reportWindow.relativeDaysToSimulate, scenario.speed, {
  resource: cityResource,
  ...cityInputs,
}, {
  startAbsoluteHour: reportWindow.startAbs,
});

const cashTable = buildHourlyResourceTable(reportWindow.relativeDaysToSimulate, scenario.speed, {
  resource: "cash",
  ...cityInputs,
}, {
  startAbsoluteHour: reportWindow.startAbs,
});

const manpowerTable = buildHourlyResourceTable(reportWindow.relativeDaysToSimulate, scenario.speed, {
  resource: "manpower",
  ...cityInputs,
}, {
  startAbsoluteHour: reportWindow.startAbs,
});

const aggregatedResource = aggregateHourlyAmountsByMapDay({
  rows: resourceTable.rows,
  scenario,
  mapDaysToReport,
});
const aggregatedCash = aggregateHourlyAmountsByMapDay({
  rows: cashTable.rows,
  scenario,
  mapDaysToReport,
});
const aggregatedManpower = aggregateHourlyAmountsByMapDay({
  rows: manpowerTable.rows,
  scenario,
  mapDaysToReport,
});

console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(
  `Scenario start: day ${scenario.start.day}, hour ${scenario.start.hour}, t0=${scenarioStartAbsoluteHour(
    scenario
  )}`
);
console.log("Scenario starting balances:", scenario.starting_balance);
console.log(`City resource: ${cityResource}`);
console.table(aggregatedResource.map((row, index) => ({
  day: row.mapDay,
  dayStartAbs: row.mapDayStartAbs,
  hoursCounted: row.hoursCounted,
  [cityResource]: row.total,
  manpower: aggregatedManpower[index]?.total ?? 0,
  cash: aggregatedCash[index]?.total ?? 0,
})));

console.log("Totals:", {
  [cityResource]: aggregatedResource.reduce((sum, row) => sum + row.total, 0),
  manpower: aggregatedManpower.reduce((sum, row) => sum + row.total, 0),
  cash: aggregatedCash.reduce((sum, row) => sum + row.total, 0),
});
