import { buildDailyResourceTable } from "./resource-table.js";
import {
  DEFAULT_MORALE_DECAY_D,
  HOMELAND_TARGET_MORALE,
  STARTING_MORALE_DAY1,
} from "./constants.js";

const t = buildDailyResourceTable(28, "4x", {
  resource: "supplies",
  startPop: 5,
  ecoInfraMultiplier: 1.0,

  moraleParams: {
    S: STARTING_MORALE_DAY1,
    T: HOMELAND_TARGET_MORALE,
    N: 0,
    D: DEFAULT_MORALE_DECAY_D,
  },
});

console.log(t.rows);
console.log("Total:", t.total);