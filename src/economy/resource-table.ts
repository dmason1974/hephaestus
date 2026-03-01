import {
  BASE_RESOURCE_PRODUCTION,
  GAME_SPEED_MULTIPLIER,
  POPULATION_MODIFIER_TABLE,
  type GameSpeed,
  type Resource,
} from "./constants.js";

import { populationAtDay } from "./population-model.js";
import { moraleOnDay, type MoraleParams } from "./morale-model.js";
import { moraleProductionMultiplier } from "./morale-modifier.js";

export type CityResourceInputs = {
  resource: Resource; // "supplies" | "components" | ...
  startPop: number; // your YAML pop level (typically 1..10)

  // ✅ required to compute morale multiplier
  moraleParams: MoraleParams;

  ecoInfraMultiplier?: number; // default 1.0
  hiddenMultiplierOverride?: number; // optional; otherwise derived from game speed
  populationOpts?: { cap?: number; b?: number }; // optional overrides
};

export type DailyResourceRow = {
  day: number; // 1..N
  amount: number; // produced units of the city's resource
};

export type DailyResourceTable = {
  rows: DailyResourceRow[];
  total: number;
};

// --- helpers ---

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function roundInt(x: number) {
  // matches your sheet style rounding
  return Math.round(x);
}

/**
 * POPULATION_MODIFIER_TABLE stores percent deltas (-80..25).
 * We interpolate between integer pop levels and return a multiplier (1 + pct/100).
 */
export function populationToMultiplier(popLevelContinuous: number): number {
  const table = POPULATION_MODIFIER_TABLE;

  const minPop = table[0].population;
  const maxPop = table[table.length - 1].population;

  const p = clamp(popLevelContinuous, minPop, maxPop);

  const lo = Math.floor(p);
  const hi = Math.ceil(p);

  const loRow = table.find((r) => r.population === lo);
  const hiRow = table.find((r) => r.population === hi);

  if (!loRow || !hiRow) {
    throw new Error(`populationToMultiplier: missing table rows for lo=${lo}, hi=${hi}`);
  }

  if (lo === hi) return 1 + loRow.percent / 100;

  const t = (p - lo) / (hi - lo);
  const pct = loRow.percent + (hiRow.percent - loRow.percent) * t;

  return 1 + pct / 100;
}

/**
 * Builds a day-by-day produced amount for a single city/resource.
 *
 * NOTE: populationAtDay uses "days since game start" (t = max(0, day)).
 * To make Day 1 equal to the starting population, we use (day - 1) as t.
 *
 * Formula (while ignoring build improvements beyond ecoInfraMultiplier):
 * amount = round(base * ecoInfra * moraleMul * popMul * hidden)
 */
export function buildDailyResourceTable(
  days: number,
  gameSpeed: GameSpeed,
  city: CityResourceInputs
): DailyResourceTable {
  if (!Number.isFinite(days) || days < 1) throw new Error(`days must be >= 1, got ${days}`);

  const ecoInfra = city.ecoInfraMultiplier ?? 1.0;

  const speedMul = GAME_SPEED_MULTIPLIER[gameSpeed];
  if (speedMul === undefined) {
    throw new Error(`Unknown gameSpeed="${gameSpeed}"`);
  }
  const hidden = city.hiddenMultiplierOverride ?? speedMul;

  const base = BASE_RESOURCE_PRODUCTION[city.resource];

  const rows: DailyResourceRow[] = [];
  let total = 0;

  for (let day = 1; day <= days; day++) {
    // ✅ morale (1-based)
    const morale = moraleOnDay(day, city.moraleParams);
    const moraleMul = moraleProductionMultiplier(morale);

    // ✅ population (Day 1 is start pop)
    const popLevel = populationAtDay(city.startPop, day - 1, city.populationOpts);
    const popMul = populationToMultiplier(popLevel);

    const amount = roundInt(base * ecoInfra * moraleMul * popMul * hidden);

    rows.push({ day, amount });
    total += amount;
  }

  return { rows, total };
}

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