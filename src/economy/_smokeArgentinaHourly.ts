import path from "node:path";

import {
  buildCountryHourlyResourceBalanceTable,
  loadCountry,
} from "./country-resource-balance.js";
import { projectRoot } from "../validation/enums.js";

const countryPath = path.join(projectRoot(), "data", "countries", "argentina.yml");
const country = loadCountry(countryPath);

const table = buildCountryHourlyResourceBalanceTable(country, 2, "4x");

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
  }))
);

console.log("Ending balances:", {
  supplies: table.endingBalances.supplies ?? 0,
  components: table.endingBalances.components ?? 0,
  fuel: table.endingBalances.fuel ?? 0,
  electronics: table.endingBalances.electronics ?? 0,
  rare: table.endingBalances.rares ?? 0,
});
