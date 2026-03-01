import { moraleOnDay, type MoraleParams } from "./morale-model.js";
import { moraleProductionMultiplier } from "./morale-modifier.js";
import { populationAtDay } from "./population-model.js";
import { populationToMultiplier } from "./resource-table.js";
import { DEFAULT_MORALE_DECAY_D, HOMELAND_TARGET_MORALE, STARTING_MORALE_DAY1 } from "./constants.js";

export type DailyMultiplierRow = {
  day: number;
  morale: number;
  moraleMul: number;
  popLevel: number;
  popMul: number;
};

export function buildDailyMultipliersTable(
  days: number,
  city: { startPop: number; populationOpts?: { cap?: number; b?: number }; moraleParams: MoraleParams }
): { rows: DailyMultiplierRow[] } {
  const rows: DailyMultiplierRow[] = [];

  for (let day = 1; day <= days; day++) {
    // morale is 1-based day index
    const morale = moraleOnDay(day, city.moraleParams);
    const moraleMul = moraleProductionMultiplier(morale);

    // populationAtDay uses "days since start", so Day 1 should be startPop => day - 1
    const popLevel = populationAtDay(city.startPop, day - 1, city.populationOpts);
    const popMul = populationToMultiplier(popLevel);

    rows.push({ day, morale, moraleMul, popLevel, popMul });
  }

  return { rows };
}

const t = buildDailyMultipliersTable(28, {
  startPop: 5,
  moraleParams: { S: STARTING_MORALE_DAY1, T: HOMELAND_TARGET_MORALE, N: 0, D: DEFAULT_MORALE_DECAY_D },
});

console.table(t.rows.map(r => ({
  day: r.day,
  morale: r.morale,
  moraleMul: Number(r.moraleMul.toFixed(4)),
  popLevel: Number(r.popLevel.toFixed(4)),
  popMul: Number(r.popMul.toFixed(4)),
})));