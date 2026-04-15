/**
 * Resource Constants
 */

export type Resource =
  | "supplies"
  | "components"
  | "fuel"
  | "rares"
  | "electronics"
  | "cash"
  | "manpower";

export const BASE_RESOURCE_PRODUCTION: Record<Exclude<Resource, "manpower">, number> = {
  supplies: 2100,
  components: 1800,
  fuel: 2100,
  electronics: 1500,
  rares: 1200,
  cash: 1500,
};

export const BASE_PROVINCE_RESOURCE_PRODUCTION: Record<Exclude<Resource, "manpower">, number> = {
  supplies: 210,
  components: 180,
  fuel: 210,
  electronics: 150,
  rares: 120,
  cash: 150,
};

export const BASE_PROVINCE_MANPOWER_PRODUCTION = 12;

export const MANPOWER_BY_POPULATION_TABLE: ReadonlyArray<{
  population: number;
  amount: number;
}> = [
  { population: 4, amount: 125 },
  { population: 5, amount: 140 },
  { population: 6, amount: 150 },
  { population: 7, amount: 160 },
  { population: 8, amount: 180 },
  { population: 9, amount: 190 },
  { population: 10, amount: 200 },
];

/**
 * Morale multiplier coefficients
 * Used for calculating morale modifiers.
 */

export const MORALE_MULTIPLIER_COEFFICIENT = 0.8;
export const MORALE_MULTIPLIER_OFFSET = 0.25;

export const STARTING_MORALE_DAY1 = 70;
export const HOMELAND_TARGET_MORALE = 93;

/**
 * Discrete morale decay parameter.
 * Your guidance: around 8.
 */
export const DEFAULT_MORALE_DECAY_D = 13;

/**
 * Population growth support
 */
export type StartingPopulation = 4 | 5 | 6;
export const CAPTURED_STARTING_POPULATION: StartingPopulation = 4;
export const CAPTURED_STARTING_MORALE_DAY1 = 25;

export const MIN_POPULATION = 4;
export const POPULATION_CAP = 10;

/**
 * Days required to grow from pop N to pop N + 1.
 * Days are measured as elapsed whole days since Day 1.
 */
export const POPULATION_GROWTH_DAYS_BY_POP = {
  4: 3.2,
  5: 10,
  6: 15,
  7: 25,
  8: 35,
  9: 45,
} as const;

/**
 * Population → percent modifier
 * Used as the default resource multiplier table for population tiers.
 */
export const POPULATION_MODIFIER_TABLE: ReadonlyArray<{
  population: number;
  percent: number;
}> = [
  { population: 1, percent: -80 },
  { population: 2, percent: -60 },
  { population: 3, percent: -40 },
  { population: 4, percent: -20 },
  { population: 5, percent: 0 },
  { population: 6, percent: 5 },
  { population: 7, percent: 10 },
  { population: 8, percent: 15 },
  { population: 9, percent: 20 },
  { population: 10, percent: 25 },
];

/**
 * v1 fitted from your 5→10 “new settings / no hospital” curve.
 * This is a per in-game day growth constant for an exponential approach to cap:
 * P(t) = K - (K - P0) * exp(-b t)
 *
 * We'll recalibrate from observations later.
 */

// Retained for comparison with the legacy exponential approximation.
export const POP_GROWTH_B_PER_DAY = 0.022314355;

/**
 * Game Speed → resource modifier
 * 
 */

export type GameSpeed = "1x" | "4x" | "4x1.4" | "10x";

export const GAME_SPEED_MULTIPLIER: Record<GameSpeed, number> = {
  "1x": 1.0,
  "4x": 0.75, // 3/4
  "4x1.4": 1.4, // ww3 elite
  "10x": 0.5,
};

export type CityStatus = "homeland" | "occupied" | "annexed";

export function defaultStartingMoraleForCityStatus(cityStatus?: CityStatus): number {
  return cityStatus === "occupied" || cityStatus === "annexed"
    ? CAPTURED_STARTING_MORALE_DAY1
    : STARTING_MORALE_DAY1;
}

export function defaultStartingPopulationForCityStatus(
  startPop: StartingPopulation,
  cityStatus?: CityStatus
): StartingPopulation {
  return cityStatus === "occupied" || cityStatus === "annexed"
    ? CAPTURED_STARTING_POPULATION
    : startPop;
}

export const CITY_STATUS_MULTIPLIER: Record<CityStatus, number> = {
  homeland: 1.0,
  occupied: 0.25,
  annexed: 0.5,
};
