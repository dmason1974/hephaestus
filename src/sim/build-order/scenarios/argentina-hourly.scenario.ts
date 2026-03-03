import {
  buildCountryHourlyResourceBalanceTable,
  loadScenarioCountry,
} from "../../../models/economy/country-resource-balance.js";
import {
  loadScenarioFile,
} from "../../../validation/scenarioPaths.js";
import { scenarioStartAbsoluteHour } from "../../../core/time.js";
import { hourOfMapDay, mapDayForAbsoluteHour, scenarioReportWindow } from "./scenario-reporting.js";

const scenarioId = "elite_ava_feb_2026";
const scenario = loadScenarioFile(scenarioId);
const country = loadScenarioCountry(scenarioId, "argentina");
const mapDaysToReport = 2;
const reportWindow = scenarioReportWindow(scenario, mapDaysToReport);

const table = buildCountryHourlyResourceBalanceTable(country, reportWindow.relativeDaysToSimulate, scenario.speed, {
  startingBalances: scenario.starting_balance,
  startAbsoluteHour: reportWindow.startAbs,
});

console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(
  `Scenario start: day ${scenario.start.day}, hour ${scenario.start.hour}, t0=${scenarioStartAbsoluteHour(
    scenario
  )}`
);
console.log("Scenario starting balances:", scenario.starting_balance);

const filteredRows = table.rows
  .map(row => {
    const absoluteHour = scenarioStartAbsoluteHour(scenario) + row.hour - 1;
    return {
      hour: row.hour,
      day: mapDayForAbsoluteHour(absoluteHour),
      hourOfDay: hourOfMapDay(absoluteHour),
      absoluteHour,
      supplies: row.balances.supplies ?? 0,
      components: row.balances.components ?? 0,
      fuel: row.balances.fuel ?? 0,
      electronics: row.balances.electronics ?? 0,
      rare: row.balances.rares ?? 0,
      manpower: row.balances.manpower ?? 0,
      cash: row.balances.cash ?? 0,
    };
  })
  .filter(row => row.absoluteHour < reportWindow.endAbsExclusive);

console.table(filteredRows);

const endingRow = filteredRows[filteredRows.length - 1];
console.log("Ending balances:", {
  supplies: endingRow?.supplies ?? 0,
  components: endingRow?.components ?? 0,
  fuel: endingRow?.fuel ?? 0,
  electronics: endingRow?.electronics ?? 0,
  rare: endingRow?.rare ?? 0,
  manpower: endingRow?.manpower ?? 0,
  cash: endingRow?.cash ?? 0,
});
