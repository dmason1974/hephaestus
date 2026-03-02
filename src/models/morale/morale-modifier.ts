import { MORALE_MULTIPLIER_COEFFICIENT, MORALE_MULTIPLIER_OFFSET } from "../../core/constants.js";

/**
 * (morale * 0.8)/100 + 0.25
 */
export function moraleProductionMultiplier(morale: number): number {
  return (morale * MORALE_MULTIPLIER_COEFFICIENT) / 100 + MORALE_MULTIPLIER_OFFSET;
}
