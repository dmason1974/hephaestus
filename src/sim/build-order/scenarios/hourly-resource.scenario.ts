import { scenarioStartAbsoluteHour } from "../../../core/time.js";
import { buildHourlyResourceBalanceTable } from "../../../models/economy/resource-table.js";
import {
  DEFAULT_MORALE_DECAY_D,
  HOMELAND_TARGET_MORALE,
  STARTING_MORALE_DAY1,
  type Resource,
} from "../../../core/constants.js";
import { moraleOnDay } from "../../../models/morale/morale-model.js";
import { loadScenarioFile } from "../../../validation/scenarioPaths.js";
import { hourOfMapDay, mapDayForAbsoluteHour, scenarioReportWindow } from "./scenario-reporting.js";

const scenarioId = "elite_ava_feb_2026";
const scenario = loadScenarioFile(scenarioId);
const cityResource: Resource = "supplies";
const mapDaysToReport = 2;
const reportWindow = scenarioReportWindow(scenario, mapDaysToReport);

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

const resourceTable = buildHourlyResourceBalanceTable(reportWindow.relativeDaysToSimulate, scenario.speed, {
  resource: cityResource,
  ...cityInputs,
}, {
  startingBalance: scenario.starting_balance[cityResource],
  startAbsoluteHour: reportWindow.startAbs,
});

const cashTable = buildHourlyResourceBalanceTable(reportWindow.relativeDaysToSimulate, scenario.speed, {
  resource: "cash",
  ...cityInputs,
}, {
  startingBalance: scenario.starting_balance.cash,
  startAbsoluteHour: reportWindow.startAbs,
});

const manpowerTable = buildHourlyResourceBalanceTable(reportWindow.relativeDaysToSimulate, scenario.speed, {
  resource: "manpower",
  ...cityInputs,
}, {
  startingBalance: scenario.starting_balance.manpower,
  startAbsoluteHour: reportWindow.startAbs,
});

console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(
  `Scenario start: day ${scenario.start.day}, hour ${scenario.start.hour}, t0=${scenarioStartAbsoluteHour(
    scenario
  )}`
);
console.log("Scenario starting balances:", {
  [cityResource]: scenario.starting_balance[cityResource],
  manpower: scenario.starting_balance.manpower,
  cash: scenario.starting_balance.cash,
});
console.log(`City resource: ${cityResource}`);
const filteredRows = resourceTable.rows
  .map((row, index) => {
    const absoluteHour = scenarioStartAbsoluteHour(scenario) + row.hour - 1;
    return {
      hour: row.hour,
      day: mapDayForAbsoluteHour(absoluteHour),
      hourOfDay: hourOfMapDay(absoluteHour),
      absoluteHour,
      calendarDay: mapDayForAbsoluteHour(absoluteHour),
      scenarioRelativeDay: Math.floor((absoluteHour - reportWindow.startAbs) / 24) + 1,
      morale: moraleOnDay(mapDayForAbsoluteHour(absoluteHour), cityInputs.moraleParams),
      [cityResource]: row.production,
      manpower: manpowerTable.rows[index]?.production ?? 0,
      cash: cashTable.rows[index]?.production ?? 0,
      [`${cityResource}Balance`]: row.balanceEnd,
      manpowerBalance: manpowerTable.rows[index]?.balanceEnd ?? 0,
      cashBalance: cashTable.rows[index]?.balanceEnd ?? 0,
    };
  })
  .filter(row => row.absoluteHour < reportWindow.endAbsExclusive);

console.table(filteredRows);

const endingRow = filteredRows[filteredRows.length - 1];
console.log("Ending balances:", {
  [cityResource]: endingRow?.[`${cityResource}Balance`] ?? 0,
  manpower: endingRow?.manpowerBalance ?? 0,
  cash: endingRow?.cashBalance ?? 0,
});
