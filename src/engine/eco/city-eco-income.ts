import type { Resource } from "../../core/constants.js";
import type { CityEcoResult } from "./city-eco-beam.js";

const RESOURCE_KEYS: Resource[] = ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"];

export function zeroResourceMap(): Record<Resource, number> {
  return { supplies: 0, components: 0, fuel: 0, rares: 0, electronics: 0, cash: 0, manpower: 0 };
}

export function addResourcesInto(target: Record<Resource, number>, src: Partial<Record<Resource, number>>): void {
  for (const r of RESOURCE_KEYS) target[r] += src[r] ?? 0;
}

export function scaleResources(src: Partial<Record<Resource, number>>, factor: number): Record<Resource, number> {
  const out = zeroResourceMap();
  for (const r of RESOURCE_KEYS) out[r] = (src[r] ?? 0) * factor;
  return out;
}

/**
 * Eco income from a single city up to (but not including) flipRelHour,
 * then flat production for the remainder of the window (hoursToSimulate).
 * Does NOT include starting balance.
 */
export function cityIncomeThroughFlip(
  city: CityEcoResult,
  flipRelHour: number,
  hoursToSimulate: number
): Record<Resource, number> {
  const total = zeroResourceMap();
  const flipH = Math.max(0, Math.min(Math.round(flipRelHour), hoursToSimulate));
  // Eco-build phase: sum per-hour production up to flip point
  for (let h = 0; h < flipH; h++) {
    addResourcesInto(total, city.hourlyCityProduction[h] ?? zeroResourceMap());
  }
  // Post-flip phase: production continues flat at the rate at the flip point
  const rateAtFlip = city.hourlyCityProduction[Math.max(0, flipH - 1)] ?? city.hourlyCityProduction[0] ?? zeroResourceMap();
  const remainingHours = hoursToSimulate - flipH;
  if (remainingHours > 0) {
    addResourcesInto(total, scaleResources(rateAtFlip, remainingHours));
  }
  return total;
}

/** Full eco income from a city for the entire window (no flip truncation). */
export function cityFullEcoIncome(city: CityEcoResult): Record<Resource, number> {
  const total = zeroResourceMap();
  for (const prod of city.hourlyCityProduction) addResourcesInto(total, prod);
  return total;
}
