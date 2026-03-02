import { buildDailyResourceTable } from "../../../models/economy/resource-table.js";
import {
  DEFAULT_MORALE_DECAY_D,
  HOMELAND_TARGET_MORALE,
  STARTING_MORALE_DAY1,
  type Resource,
} from "../../../core/constants.js";

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

const resourceTable = buildDailyResourceTable(28, "4x", {
  resource: cityResource,
  ...cityInputs,
});

const cashTable = buildDailyResourceTable(28, "4x", {
  resource: "cash",
  ...cityInputs,
});

const manpowerTable = buildDailyResourceTable(28, "4x", {
  resource: "manpower",
  ...cityInputs,
});

console.log(`City resource: ${cityResource}`);
console.table(resourceTable.rows.map((row, index) => ({
  day: row.day,
  [cityResource]: row.amount,
  manpower: manpowerTable.rows[index]?.amount ?? 0,
  cash: cashTable.rows[index]?.amount ?? 0,
})));

console.log("Totals:", {
  [cityResource]: resourceTable.total,
  manpower: manpowerTable.total,
  cash: cashTable.total,
});
