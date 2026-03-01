export interface MoraleParams {
  S: number; // starting morale (day 1)
  T: number; // base target morale
  N: number; // modifiers
  D: number; // decay constant
  min?: number; // default 0
  max?: number; // optional hard cap (default 100)
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

  const target = p.T + p.N;                 // effective target morale for this city
  const max = Math.min(hardMax, target);    // cap by target (and by 100 if target > 100)

  const gap = target - p.S;
  const r = (p.D - 1) / p.D;

  let x =
    z <= 6
      ? target - gap * Math.pow(r, z - 1)
      : (target - gap * Math.pow(r, 5)) + (z - 6);

  x = Math.round(x); // integer morale

  if (x < min) return min;
  if (x > max) return max;
  return x;
}