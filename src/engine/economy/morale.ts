import {
  DEFAULT_MORALE_DECAY_D,
  HOMELAND_TARGET_MORALE,
  MORALE_MULTIPLIER_COEFFICIENT,
  MORALE_MULTIPLIER_OFFSET,
  STARTING_MORALE_DAY1,
} from "../../core/constants.js";
import type { BuildingsFile } from "../../schemas/building-schema.js";
import { undergroundBunkerMoraleBonusN } from "../economy/building-modifiers.js";

export interface MoraleParams {
  S: number;
  T: number;
  N: number;
  D: number;
  min?: number;
  max?: number;
}

/**
 * Exact formula + integer morale + capped at effective target (T+N).
 * z is 1-based (day 0 does not exist).
 */
export function moraleOnDay(z: number, p: MoraleParams): number {
  if (!Number.isFinite(z) || z < 1) throw new Error(`moraleOnDay: z must be >= 1, got ${z}`);
  if (!Number.isFinite(p.D) || p.D <= 1) throw new Error(`moraleOnDay: D must be > 1, got ${p.D}`);

  const min = p.min ?? 0;
  const hardMax = p.max ?? 100;
  const target = p.T + p.N;
  const max = Math.min(hardMax, target);
  const gap = target - p.S;
  const r = (p.D - 1) / p.D;

  let x =
    z <= 6
      ? target - gap * Math.pow(r, z - 1)
      : (target - gap * Math.pow(r, 5)) + (z - 6);

  x = Math.round(x);

  if (x < min) return min;
  if (x > max) return max;
  return x;
}

export function moraleOnDayWithDynamicBonus(
  day: number,
  args: Omit<MoraleParams, "N"> & {
    bonusForDay: (day: number) => number;
  }
): number {
  if (!Number.isFinite(day) || day < 1) {
    throw new Error(`moraleOnDayWithDynamicBonus: day must be >= 1, got ${day}`);
  }
  if (!Number.isFinite(args.D) || args.D <= 1) {
    throw new Error(`moraleOnDayWithDynamicBonus: D must be > 1, got ${args.D}`);
  }

  const min = args.min ?? 0;
  const hardMax = args.max ?? 100;
  const r = (args.D - 1) / args.D;
  let morale = Math.round(args.S);

  for (let currentDay = 2; currentDay <= day; currentDay++) {
    const target = Math.min(hardMax, args.T + args.bonusForDay(currentDay));
    const nextMorale =
      currentDay <= 6
        ? Math.round(target - ((target - morale) * r))
        : morale < target
          ? Math.min(target, morale + 1)
          : morale;

    morale = Math.max(min, Math.min(hardMax, nextMorale));
  }

  return Math.max(min, Math.min(hardMax, morale));
}

export function baselineHomelandMoraleOnDay(day: number): number {
  return homelandMoraleOnDayWithBunkers(day, 0);
}

export function homelandMoraleOnDayWithBunkers(
  day: number,
  bunkerLevelAtDayStart: number,
  buildings?: BuildingsFile
): number {
  return moraleOnDay(day, {
    S: STARTING_MORALE_DAY1,
    T: HOMELAND_TARGET_MORALE,
    N:
      bunkerLevelAtDayStart <= 0
        ? 0
        : undergroundBunkerMoraleBonusN(
            buildings ??
              (() => {
                throw new Error("buildings file is required when bunkerLevelAtDayStart is greater than 0");
              })(),
            bunkerLevelAtDayStart
          ),
    D: DEFAULT_MORALE_DECAY_D,
  });
}

/**
 * (morale * 0.8)/100 + 0.25
 */
export function moraleProductionMultiplier(morale: number): number {
  const raw = (morale * MORALE_MULTIPLIER_COEFFICIENT) / 100 + MORALE_MULTIPLIER_OFFSET;
  return Math.round(raw * 100) / 100;
}
