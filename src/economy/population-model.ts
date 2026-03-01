import { POPULATION_CAP, POP_GROWTH_B_PER_DAY } from "./constants.js";

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

/**
 * Continuous model (sampled daily):
 * P(t) = K - (K - P0) * exp(-b t)
 *
 * - t is days since game start
 * - P0 is starting population from your YAML
 */
export function populationAtDay(
  startPop: number,
  day: number,
  opts?: { cap?: number; b?: number }
): number {
  const K = opts?.cap ?? POPULATION_CAP;
  const b = opts?.b ?? POP_GROWTH_B_PER_DAY;

  const P0 = clamp(startPop, 0, K);
  const t = Math.max(0, day);

  return K - (K - P0) * Math.exp(-b * t);
}

export function simulatePopulation(
  days: number,
  startPop: number,
  opts?: { cap?: number; b?: number }
): number[] {
  const series: number[] = [];
  for (let d = 0; d <= days; d++) {
    series.push(populationAtDay(startPop, d, opts));
  }
  return series;
}