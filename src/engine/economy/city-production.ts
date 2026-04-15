import {
  BASE_RESOURCE_PRODUCTION,
  CITY_STATUS_MULTIPLIER,
  GAME_SPEED_MULTIPLIER,
  MANPOWER_BY_POPULATION_TABLE,
  MIN_POPULATION,
  POPULATION_CAP,
  POPULATION_MODIFIER_TABLE,
  type CityStatus,
  type GameSpeed,
  type Resource,
  type StartingPopulation,
} from "../../core/constants.js";

import {
  dayAtPopulation,
  daysToNextPopulation,
  populationAtDay,
  type PopulationMode,
  type PopulationModelOptions,
} from "./population.js";
import {
  moraleOnDay,
  moraleProductionMultiplier,
  type MoraleParams,
} from "./morale.js";
import { type EconomicBuildingEffects } from "./building-modifiers.js";

export type CityResourceInputs = {
  resource: Resource; // "supplies" | "components" | ...
  startPop: StartingPopulation;

  // ✅ required to compute morale multiplier
  moraleParams: MoraleParams;
  moraleOverride?: number;

  ecoInfraMultiplier?: number; // default 1.0
  hiddenMultiplierOverride?: number; // optional; otherwise derived from game speed
  populationMode?: PopulationMode;
  populationOpts?: PopulationModelOptions;
  multiplierByPop?: Record<number, number>;
  cityStatus?: CityStatus;
  buildingEffects?: EconomicBuildingEffects;
};

export type DailyResourceRow = {
  day: number; // 1..N
  amount: number; // produced units of the city's resource
};

export type DailyResourceTable = {
  rows: DailyResourceRow[];
  total: number;
};

export type HourlyResourceRow = {
  hour: number; // 1..days*24
  day: number; // 1-based day number
  hourOfDay: number; // 1..24
  amount: number; // produced units during this game hour
};

export type HourlyResourceTable = {
  rows: HourlyResourceRow[];
  total: number;
};

export type HourlyResourcePoint = {
  day: number;
  hourOfDay: number;
  amount: number;
};

export type HourlyBalanceRow = {
  hour: number;
  day: number;
  hourOfDay: number;
  production: number;
  balanceStart: number;
  balanceEnd: number;
};

export type HourlyBalanceTable = {
  rows: HourlyBalanceRow[];
  endingBalance: number;
};

// --- helpers ---

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function roundInt(x: number) {
  // matches your sheet style rounding
  return Math.round(x);
}

function floorInt(x: number) {
  return Math.floor(x);
}

function flatBonusForResource(
  buildingEffects: EconomicBuildingEffects | undefined,
  resource: Resource
) {
  return buildingEffects?.flatBonuses[resource] ?? 0;
}

function populationBonusMultiplier(buildingEffects: EconomicBuildingEffects | undefined) {
  return 1 + (buildingEffects?.populationBonusPct ?? 0);
}

export const DEFAULT_MULTIPLIER_BY_POP = Object.fromEntries(
  POPULATION_MODIFIER_TABLE.map(({ population, percent }) => [population, 1 + percent / 100])
) as Record<number, number>;

function resolveMultiplierBounds(multiplierByPop: Record<number, number>) {
  const populations = Object.keys(multiplierByPop)
    .map(key => Number(key))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (populations.length === 0) {
    throw new Error("multiplierByPop must contain at least one population entry");
  }

  return {
    minPop: populations[0],
    maxPop: populations[populations.length - 1],
  };
}

export function populationToMultiplier(
  popLevelContinuous: number,
  multiplierByPop: Record<number, number> = DEFAULT_MULTIPLIER_BY_POP
): number {
  const { minPop, maxPop } = resolveMultiplierBounds(multiplierByPop);
  const p = clamp(popLevelContinuous, minPop, maxPop);
  const lo = Math.floor(p);
  const hi = Math.ceil(p);
  const loMultiplier = multiplierByPop[lo];
  const hiMultiplier = multiplierByPop[hi];

  if (loMultiplier === undefined || hiMultiplier === undefined) {
    throw new Error(`Missing population multiplier for pop range ${lo}..${hi}`);
  }

  if (lo === hi) return loMultiplier;

  const t = (p - lo) / (hi - lo);
  return loMultiplier + (hiMultiplier - loMultiplier) * t;
}

export function populationToManpower(popLevelContinuous: number): number {
  const minPop = MANPOWER_BY_POPULATION_TABLE[0].population;
  const maxPop = MANPOWER_BY_POPULATION_TABLE[MANPOWER_BY_POPULATION_TABLE.length - 1].population;
  const p = clamp(popLevelContinuous, minPop, maxPop);
  const lo = Math.floor(p);
  const hi = Math.ceil(p);
  const loRow = MANPOWER_BY_POPULATION_TABLE.find(row => row.population === lo);
  const hiRow = MANPOWER_BY_POPULATION_TABLE.find(row => row.population === hi);

  if (!loRow || !hiRow) {
    throw new Error(`Missing manpower row for pop range ${lo}..${hi}`);
  }

  if (lo === hi) return loRow.amount;

  const t = (p - lo) / (hi - lo);
  return loRow.amount + ((hiRow.amount - loRow.amount) * t);
}

export function populationToEffectiveLevel(population: {
  popInt: number;
  popFloat?: number;
  progressToNext?: number;
}) {
  if (population.popFloat !== undefined) return population.popFloat;
  if (population.progressToNext === undefined || population.progressToNext >= 1) {
    return population.popInt;
  }

  return population.popInt + population.progressToNext;
}

export type PopulationMultiplierDetails = {
  popInt: number;
  multiplier: number;
  incrementalGain: number;
  marginalGainPerDay: number;
  daysToNextPop?: number;
};

export function populationMultiplierDetails(
  popInt: number,
  multiplierByPop: Record<number, number>,
  populationOpts?: PopulationModelOptions
): PopulationMultiplierDetails {
  const minPop = populationOpts?.minPop ?? MIN_POPULATION;
  const maxPop = populationOpts?.maxPop ?? POPULATION_CAP;
  const clampedPop = clamp(Math.floor(popInt), minPop, maxPop);
  const multiplier = populationToMultiplier(clampedPop, multiplierByPop);
  const previousMultiplier =
    clampedPop > minPop
      ? populationToMultiplier(clampedPop - 1, multiplierByPop)
      : multiplier;
  const incrementalGain = clampedPop > minPop ? multiplier - previousMultiplier : 0;
  const durationDays = daysToNextPopulation(clampedPop, populationOpts);

  return {
    popInt: clampedPop,
    multiplier,
    incrementalGain,
    marginalGainPerDay:
      durationDays === undefined || durationDays === 0
        ? 0
        : incrementalGain / durationDays,
    daysToNextPop: durationDays,
  };
}

export type MarginalReturnsRow = {
  popFrom: number;
  popTo: number;
  dayStartInclusive: number;
  dayEndExclusive: number;
  durationDays: number;
  multiplierFrom: number;
  multiplierTo: number;
  incrementalGain: number;
  marginalGainPerDay: number;
};

export function marginalReturnsSchedule(
  startPop: StartingPopulation,
  horizonDays: number,
  multiplierByPop: Record<number, number>,
  populationOpts?: PopulationModelOptions
): MarginalReturnsRow[] {
  if (!Number.isFinite(horizonDays) || horizonDays < 1) {
    throw new Error(`horizonDays must be >= 1, got ${horizonDays}`);
  }

  const maxPop = populationOpts?.maxPop ?? POPULATION_CAP;
  const rows: MarginalReturnsRow[] = [];

  for (let popFrom = startPop; popFrom < maxPop; popFrom++) {
    const dayStartInclusive = dayAtPopulation(popFrom, startPop, "step", populationOpts);
    if (dayStartInclusive > horizonDays) break;

    const popTo = popFrom + 1;
    const dayEndExclusive = dayAtPopulation(popTo, startPop, "step", populationOpts);
    const durationDays = dayEndExclusive - dayStartInclusive;
    const multiplierFrom = populationToMultiplier(popFrom, multiplierByPop);
    const multiplierTo = populationToMultiplier(popTo, multiplierByPop);
    const incrementalGain = multiplierTo - multiplierFrom;

    rows.push({
      popFrom,
      popTo,
      dayStartInclusive,
      dayEndExclusive,
      durationDays,
      multiplierFrom,
      multiplierTo,
      incrementalGain,
      marginalGainPerDay: incrementalGain / durationDays,
    });
  }

  return rows;
}

/**
 * Builds a day-by-day produced amount for a single city/resource.
 *
 * Formula (while ignoring build improvements beyond ecoInfraMultiplier):
 * amount = floor(base * ecoInfra * moraleMul * popMul * hidden)
 */
export function buildDailyResourceTable(
  days: number,
  gameSpeed: GameSpeed,
  city: CityResourceInputs
): DailyResourceTable {
  if (!Number.isFinite(days) || days < 1) throw new Error(`days must be >= 1, got ${days}`);

  const ecoInfra = city.ecoInfraMultiplier ?? 1.0;
  const populationMode = city.populationMode ?? "step";
  const multiplierByPop = city.multiplierByPop ?? DEFAULT_MULTIPLIER_BY_POP;
  const buildingEffects = city.buildingEffects;
  const cityStatusMultiplier = CITY_STATUS_MULTIPLIER[city.cityStatus ?? "homeland"];

  const speedMul = GAME_SPEED_MULTIPLIER[gameSpeed];
  if (speedMul === undefined) {
    throw new Error(`Unknown gameSpeed="${gameSpeed}"`);
  }
  const hidden = city.hiddenMultiplierOverride ?? speedMul;

  const rows: DailyResourceRow[] = [];
  let total = 0;

  for (let day = 1; day <= days; day++) {
    // ✅ morale (1-based)
    const morale = city.moraleOverride ?? moraleOnDay(day, city.moraleParams);
    const moraleMul = moraleProductionMultiplier(morale);

    const population = populationAtDay(day, city.startPop, populationMode, city.populationOpts);
    const popDecimal = populationToEffectiveLevel(population);
    const popMul = populationToMultiplier(popDecimal, multiplierByPop);
    const productionMultiplier = 1 + (buildingEffects?.productionBonusPct ?? 0);
    const manpowerMultiplier = 1 + (buildingEffects?.manpowerBonusPct ?? 0);
    const flatBonus = flatBonusForResource(buildingEffects, city.resource);

    const amount = city.resource === "manpower"
      ? roundInt((populationToManpower(popDecimal) * manpowerMultiplier) + flatBonus)
      : floorInt(
          (BASE_RESOURCE_PRODUCTION[city.resource] *
            ecoInfra *
            moraleMul *
            popMul *
            hidden *
            productionMultiplier *
            cityStatusMultiplier) +
          flatBonus
        );

    rows.push({ day, amount });
    total += amount;
  }

  return { rows, total };
}

export function buildHourlyResourceTable(
  days: number,
  gameSpeed: GameSpeed,
  city: CityResourceInputs,
  opts?: {
    startAbsoluteHour?: number;
  }
): HourlyResourceTable {
  const rows: HourlyResourceRow[] = [];
  let total = 0;
  const startAbsoluteHour = opts?.startAbsoluteHour ?? 0;

  for (let index = 0; index < days * 24; index++) {
    const absoluteHour = startAbsoluteHour + index;
    const point = hourlyResourcePointAtAbsoluteHour(gameSpeed, city, absoluteHour);
    const hour = index + 1;

    rows.push({
      hour,
      day: point.day,
      hourOfDay: point.hourOfDay,
      amount: point.amount,
    });
    total += point.amount;
  }

  return { rows, total };
}

export function hourlyResourcePointAtAbsoluteHour(
  gameSpeed: GameSpeed,
  city: CityResourceInputs,
  absoluteHour: number
): HourlyResourcePoint {
  const ecoInfra = city.ecoInfraMultiplier ?? 1.0;
  const populationMode = city.populationMode ?? "step";
  const multiplierByPop = city.multiplierByPop ?? DEFAULT_MULTIPLIER_BY_POP;
  const buildingEffects = city.buildingEffects;
  const cityStatusMultiplier = CITY_STATUS_MULTIPLIER[city.cityStatus ?? "homeland"];

  const speedMul = GAME_SPEED_MULTIPLIER[gameSpeed];
  if (speedMul === undefined) {
    throw new Error(`Unknown gameSpeed="${gameSpeed}"`);
  }
  const hidden = city.hiddenMultiplierOverride ?? speedMul;
  const calendarDay = Math.floor(absoluteHour / 24) + 1;
  const populationDay = 1 + ((absoluteHour / 24) * populationBonusMultiplier(buildingEffects));
  const morale = city.moraleOverride ?? moraleOnDay(calendarDay, city.moraleParams);
  const moraleMul = moraleProductionMultiplier(morale);
  const population = populationAtDay(populationDay, city.startPop, populationMode, city.populationOpts);
  const popDecimal = populationToEffectiveLevel(population);
  const popMul = populationToMultiplier(popDecimal, multiplierByPop);
  const productionMultiplier = 1 + (buildingEffects?.productionBonusPct ?? 0);
  const manpowerMultiplier = 1 + (buildingEffects?.manpowerBonusPct ?? 0);
  const flatBonus = flatBonusForResource(buildingEffects, city.resource);
  const dailyAmount =
    city.resource === "manpower"
      ? roundInt((populationToManpower(popDecimal) * manpowerMultiplier) + flatBonus)
      : floorInt(
          (BASE_RESOURCE_PRODUCTION[city.resource] * ecoInfra * moraleMul * popMul * hidden * productionMultiplier * cityStatusMultiplier) +
          flatBonus
        );
  const hourlyAmount = Math.floor(dailyAmount / 24);
  const hourOfDay = (absoluteHour % 24) + 1;

  return {
    day: calendarDay,
    hourOfDay,
    amount: hourlyAmount,
  };
}

export function buildHourlyResourceBalanceTable(
  days: number,
  gameSpeed: GameSpeed,
  city: CityResourceInputs,
  opts?: {
    startingBalance?: number;
    startAbsoluteHour?: number;
  }
): HourlyBalanceTable {
  const hourly = buildHourlyResourceTable(days, gameSpeed, city, {
    startAbsoluteHour: opts?.startAbsoluteHour,
  });
  const rows: HourlyBalanceRow[] = [];
  let balance = opts?.startingBalance ?? 0;

  if (!Number.isFinite(balance)) {
    throw new Error(`startingBalance must be finite, got ${balance}`);
  }

  for (const hourRow of hourly.rows) {
    const balanceStart = balance;
    balance += hourRow.amount;

    rows.push({
      hour: hourRow.hour,
      day: hourRow.day,
      hourOfDay: hourRow.hourOfDay,
      production: hourRow.amount,
      balanceStart,
      balanceEnd: balance,
    });
  }

  return {
    rows,
    endingBalance: balance,
  };
}

export type DailyMultiplierRow = {
  day: number;
  morale: number;
  moraleMul: number;
  popDecimal: number;
  popMul: number;
};

export function buildDailyMultipliersTable(
  days: number,
  city: {
    startPop: StartingPopulation;
    populationMode?: PopulationMode;
    populationOpts?: PopulationModelOptions;
    moraleParams: MoraleParams;
    multiplierByPop?: Record<number, number>;
  }
): { rows: DailyMultiplierRow[] } {
  const rows: DailyMultiplierRow[] = [];
  const populationMode = city.populationMode ?? "step";
  const multiplierByPop = city.multiplierByPop ?? DEFAULT_MULTIPLIER_BY_POP;

  for (let day = 1; day <= days; day++) {
    // morale is 1-based day index
    const morale = moraleOnDay(day, city.moraleParams);
    const moraleMul = moraleProductionMultiplier(morale);

    const population = populationAtDay(day, city.startPop, populationMode, city.populationOpts);
    const popDecimal = populationToEffectiveLevel(population);
    const popMul = populationToMultiplier(popDecimal, multiplierByPop);

    rows.push({
      day,
      morale,
      moraleMul,
      popDecimal,
      popMul,
    });
  }

  return { rows };
}
