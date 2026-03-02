import {
  buildCountryHourlyResourceBalanceTable,
  loadScenarioCountry,
} from "../../../models/economy/country-resource-balance.js";
import {
  loadScenarioFile,
} from "../../../validation/scenarioPaths.js";

const scenarioId = "elite_ava_feb_2026";
const scenario = loadScenarioFile(scenarioId);
const country = loadScenarioCountry(scenarioId, "argentina");

const table = buildCountryHourlyResourceBalanceTable(country, 2, scenario.speed, {
  startingBalances: scenario.starting_balance,
});

console.table(
  table.rows.map(row => ({
    hour: row.hour,
    day: row.day,
    hourOfDay: row.hourOfDay,
    supplies: row.balances.supplies ?? 0,
    components: row.balances.components ?? 0,
    fuel: row.balances.fuel ?? 0,
    electronics: row.balances.electronics ?? 0,
    rare: row.balances.rares ?? 0,
    manpower: row.balances.manpower ?? 0,
    cash: row.balances.cash ?? 0,
  }))
);

console.log("Ending balances:", {
  supplies: table.endingBalances.supplies ?? 0,
  components: table.endingBalances.components ?? 0,
  fuel: table.endingBalances.fuel ?? 0,
  electronics: table.endingBalances.electronics ?? 0,
  rare: table.endingBalances.rares ?? 0,
  manpower: table.endingBalances.manpower ?? 0,
  cash: table.endingBalances.cash ?? 0,
});
