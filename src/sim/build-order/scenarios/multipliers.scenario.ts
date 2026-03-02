import { DEFAULT_MORALE_DECAY_D, HOMELAND_TARGET_MORALE, STARTING_MORALE_DAY1 } from "../../../core/constants.js";
import { buildDailyMultipliersTable } from "../../../models/economy/resource-table.js";

const t = buildDailyMultipliersTable(28, {
  startPop: 5,
  populationMode: "step",
  moraleParams: {
    S: STARTING_MORALE_DAY1,
    T: HOMELAND_TARGET_MORALE,
    N: 0,
    D: DEFAULT_MORALE_DECAY_D,
  },
});

console.table(
  t.rows.map(r => ({
    day: r.day,
    morale: r.morale,
    moraleMul: Number(r.moraleMul.toFixed(4)),
    popDecimal: Number(r.popDecimal.toFixed(4)),
    popMul: Number(r.popMul.toFixed(4)),
  }))
);
