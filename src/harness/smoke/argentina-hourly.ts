import {
  buildCountryHourlyResourceBalanceTable,
} from "../../engine/reporting/country-resource-balance.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import { hourOfMapDay, mapDayForAbsoluteHour, scenarioReportWindow } from "../../engine/reporting/scenario-reporting.js";

const scenarioId = "elite/antarctica";
const scenario = loadScenarioFile(scenarioId);
const country = loadScenarioCountry(scenarioId, "argentina");
const buildings = loadBuildingsFile();
const mapDaysToReport = 2;
const reportWindow = scenarioReportWindow(scenario, mapDaysToReport);

const table = buildCountryHourlyResourceBalanceTable(country, reportWindow.relativeDaysToSimulate, scenario.speed, {
  buildingsFile: buildings,
  scenario,
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
  .flatMap(row => {
    const absoluteHour = scenarioStartAbsoluteHour(scenario) + row.hour - 1;
    if (absoluteHour >= reportWindow.endAbsExclusive) return [];

    return [{
      day: mapDayForAbsoluteHour(absoluteHour),
      hourOfDay: hourOfMapDay(absoluteHour),
      supplies: row.balances.supplies ?? 0,
      components: row.balances.components ?? 0,
      fuel: row.balances.fuel ?? 0,
      electronics: row.balances.electronics ?? 0,
      rare: row.balances.rares ?? 0,
      manpower: row.balances.manpower ?? 0,
      cash: row.balances.cash ?? 0,
    }];
  });

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
