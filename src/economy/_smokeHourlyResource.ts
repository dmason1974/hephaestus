import { buildHourlyResourceBalanceTable } from "./resource-table.js";
import {
  DEFAULT_MORALE_DECAY_D,
  HOMELAND_TARGET_MORALE,
  STARTING_MORALE_DAY1,
} from "./constants.js";

const table = buildHourlyResourceBalanceTable(2, "4x", {
  resource: "supplies",
  startPop: 5,
  ecoInfraMultiplier: 1.0,
  moraleParams: {
    S: STARTING_MORALE_DAY1,
    T: HOMELAND_TARGET_MORALE,
    N: 0,
    D: DEFAULT_MORALE_DECAY_D,
  },
}, {
  startingBalance: 1000,
});

console.table(
  table.rows.map(row => ({
    hour: row.hour,
    day: row.day,
    hourOfDay: row.hourOfDay,
    production: row.production,
    balanceStart: row.balanceStart,
    balanceEnd: row.balanceEnd,
  }))
);

console.log("Ending balance:", table.endingBalance);
