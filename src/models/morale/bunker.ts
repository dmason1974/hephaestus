const BUNKER_MORALE_BONUS_N: Record<number, number> = {
  0: 0,
  1: 5,
  2: 10,
  3: 20,
  4: 35,
  5: 50,
};

export function bunkerMoraleBonusN(level: number): number {
  const clampedLevel = Math.max(0, Math.min(5, Math.floor(level)));
  return BUNKER_MORALE_BONUS_N[clampedLevel] ?? 0;
}
