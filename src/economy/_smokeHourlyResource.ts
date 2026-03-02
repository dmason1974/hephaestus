import { buildHourlyResourceBalanceTable } from "./resource-table.js";
import {
  DEFAULT_MORALE_DECAY_D,
  HOMELAND_TARGET_MORALE,
  STARTING_MORALE_DAY1,
  type Resource,
} from "./constants.js";

const cityResource: Resource = "supplies";

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

const resourceTable = buildHourlyResourceBalanceTable(2, "4x", {
  resource: cityResource,
  ...cityInputs,
}, {
  startingBalance: 0,
});

const cashTable = buildHourlyResourceBalanceTable(2, "4x", {
  resource: "cash",
  ...cityInputs,
}, {
  startingBalance: 0,
});

const manpowerTable = buildHourlyResourceBalanceTable(2, "4x", {
  resource: "manpower",
  ...cityInputs,
}, {
  startingBalance: 0,
});

console.log(`City resource: ${cityResource}`);
console.table(
  resourceTable.rows.map((row, index) => ({
    hour: row.hour,
    day: row.day,
    hourOfDay: row.hourOfDay,
    [cityResource]: row.production,
    manpower: manpowerTable.rows[index]?.production ?? 0,
    cash: cashTable.rows[index]?.production ?? 0,
    [`${cityResource}Balance`]: row.balanceEnd,
    manpowerBalance: manpowerTable.rows[index]?.balanceEnd ?? 0,
    cashBalance: cashTable.rows[index]?.balanceEnd ?? 0,
  }))
);

console.log("Ending balances:", {
  [cityResource]: resourceTable.endingBalance,
  manpower: manpowerTable.endingBalance,
  cash: cashTable.endingBalance,
});
