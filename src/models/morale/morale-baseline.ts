import {
  STARTING_MORALE_DAY1,
  HOMELAND_TARGET_MORALE,
  DEFAULT_MORALE_DECAY_D,
} from "../../core/constants.js";
import { bunkerMoraleBonusN } from "./bunker.js";
import { moraleOnDay } from "./morale-model.js";

export function baselineHomelandMoraleOnDay(day: number): number {
  return homelandMoraleOnDayWithBunkers(day, 0);
}

export function homelandMoraleOnDayWithBunkers(
  day: number,
  bunkerLevelAtDayStart: number
): number {
  return moraleOnDay(day, {
    S: STARTING_MORALE_DAY1,
    T: HOMELAND_TARGET_MORALE,
    N: bunkerMoraleBonusN(bunkerLevelAtDayStart),
    D: DEFAULT_MORALE_DECAY_D,
  });
}
