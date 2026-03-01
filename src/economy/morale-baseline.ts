import {
  STARTING_MORALE_DAY1,
  HOMELAND_TARGET_MORALE,
  DEFAULT_MORALE_DECAY_D,
} from "./constants.js";
import { moraleOnDay } from "./morale-model.js";

export function baselineHomelandMoraleOnDay(day: number): number {
  return moraleOnDay(day, {
    S: STARTING_MORALE_DAY1,
    T: HOMELAND_TARGET_MORALE,
    N: 0,
    D: DEFAULT_MORALE_DECAY_D,
  });
}