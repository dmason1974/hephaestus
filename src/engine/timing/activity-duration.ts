export function durationToHours(duration: {
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
}): number {
  return (
    (duration.days ?? 0) * 24 +
    (duration.hours ?? 0) +
    (duration.minutes ?? 0) / 60 +
    (duration.seconds ?? 0) / 3600
  );
}

const MIN_MORALE = 0;
const MAX_MORALE = 100;
const NO_PENALTY_MORALE = 90;
const MAX_PENALTY_MORALE = 25;
const MIN_SPEED = 0.75;
const MAX_SLOWDOWN_MULTIPLIER = 4 / 3;

function validateBaseDuration(baseDuration: number) {
  if (!Number.isFinite(baseDuration) || baseDuration < 0) {
    throw new Error(`baseDuration must be >= 0, got ${baseDuration}`);
  }
}

function validateMorale(moralePct: number) {
  if (!Number.isFinite(moralePct) || moralePct < MIN_MORALE || moralePct > MAX_MORALE) {
    throw new Error(`moralePct must be between 0 and 100, got ${moralePct}`);
  }
}

export function effectiveDurationFromMorale(baseDuration: number, moralePct: number): number {
  validateBaseDuration(baseDuration);
  validateMorale(moralePct);

  if (moralePct >= NO_PENALTY_MORALE) {
    return baseDuration;
  }

  if (moralePct <= MAX_PENALTY_MORALE) {
    return baseDuration * MAX_SLOWDOWN_MULTIPLIER;
  }

  const moraleProgress =
    (moralePct - MAX_PENALTY_MORALE) / (NO_PENALTY_MORALE - MAX_PENALTY_MORALE);
  const speed = MIN_SPEED + (0.25 * moraleProgress);
  return baseDuration / speed;
}
