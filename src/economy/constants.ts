/**
 * Resource Constants
 */

export type Resource =
  | "supplies"
  | "components"
  | "fuel"
  | "rares"
  | "electronics";

export const BASE_RESOURCE_PRODUCTION: Record<Resource, number> = {
  supplies: 2100,
  components: 1800,
  fuel: 2100,
  electronics: 1500,
  rares: 1200,
};

/**
 * Morale multiplier coefficients
 * Used for calculating morale modifiers.
 */

export const MORALE_MULTIPLIER_COEFFICIENT = 0.8;
export const MORALE_MULTIPLIER_OFFSET = 0.25;

export const STARTING_MORALE_DAY1 = 70;
export const HOMELAND_TARGET_MORALE = 90;

/**
 * Discrete morale decay parameter.
 * Your guidance: around 8.
 */
export const DEFAULT_MORALE_DECAY_D = 8;

/**
 * Population → percent modifier
 * Used for linear interpolation between integer population values.
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

export const POPULATION_CAP = 10;
export const POP_GROWTH_B_PER_DAY = 0.0186;

/**
 * Game Speed → resource modifier
 * 
 */

export type GameSpeed = "1x" | "4x" | "10x";

export const GAME_SPEED_MULTIPLIER: Record<GameSpeed, number> = {
  "1x": 1.0,
  "4x": 0.75, // 3/4
  "10x": 0.5,
};