import {
  MIN_POPULATION,
  POPULATION_CAP,
  POPULATION_GROWTH_DAYS_BY_POP,
  type StartingPopulation,
} from "../../core/constants.js";

export type PopulationMode = "step" | "smooth";

export type PopulationModelOptions = {
  minPop?: number;
  maxPop?: number;
};

export type PopulationAtDayResult = {
  popInt: number;
  popFloat?: number;
  progressToNext?: number;
};

const SMOOTH_A = 3.5;
const SMOOTH_B = 1.5;
const FLOAT_TOLERANCE = 1e-9;

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function floorWithTolerance(n: number) {
  return Math.floor(n + FLOAT_TOLERANCE);
}

function ceilWithTolerance(n: number) {
  return Math.ceil(n - FLOAT_TOLERANCE);
}

function validateDay(day: number) {
  if (!Number.isFinite(day) || day < 1) {
    throw new Error(`day must be >= 1, got ${day}`);
  }
}

function validateStartingPopulation(startPop: number): asserts startPop is StartingPopulation {
  if (startPop !== 4 && startPop !== 5 && startPop !== 6) {
    throw new Error(`startPop must be 4, 5, or 6, got ${startPop}`);
  }
}

function resolveBounds(startPop: StartingPopulation, opts?: PopulationModelOptions) {
  const minPop = opts?.minPop ?? MIN_POPULATION;
  const maxPop = opts?.maxPop ?? POPULATION_CAP;

  if (!Number.isFinite(minPop) || !Number.isFinite(maxPop) || minPop > maxPop) {
    throw new Error(`invalid population bounds min=${minPop}, max=${maxPop}`);
  }

  return {
    minPop,
    maxPop,
    clampedStartPop: clamp(startPop, minPop, maxPop),
  };
}

function growthDaysForPop(pop: number, maxPop: number) {
  if (pop >= maxPop) return undefined;

  const days = POPULATION_GROWTH_DAYS_BY_POP[
    pop as keyof typeof POPULATION_GROWTH_DAYS_BY_POP
  ];

  if (days === undefined) {
    throw new Error(`missing growth duration for pop ${pop}`);
  }

  return days;
}

function smoothElapsedDaysAtPopulation(pop: number) {
  const x = pop - MIN_POPULATION;
  return SMOOTH_A * x * x + SMOOTH_B * x;
}

function smoothPopulationAtElapsedDays(elapsedDaysFromMin: number) {
  return MIN_POPULATION + (-SMOOTH_B + Math.sqrt((SMOOTH_B * SMOOTH_B) + (14 * elapsedDaysFromMin))) / 7;
}

export function daysToNextPopulation(
  popInt: number,
  opts?: PopulationModelOptions
): number | undefined {
  const bounds = resolveBounds(MIN_POPULATION, opts);
  const clampedPop = clamp(floorWithTolerance(popInt), bounds.minPop, bounds.maxPop);
  return growthDaysForPop(clampedPop, bounds.maxPop);
}

export function dayAtPopulation(
  pop: number,
  startPop: StartingPopulation,
  mode: PopulationMode,
  opts?: PopulationModelOptions
): number {
  validateStartingPopulation(startPop);

  const bounds = resolveBounds(startPop, opts);
  const clampedStartPop = bounds.clampedStartPop;

  if (mode === "step") {
    const targetPop = clamp(ceilWithTolerance(pop), bounds.minPop, bounds.maxPop);

    if (targetPop <= clampedStartPop) return 1;

    let day = 1;
    for (let currentPop = clampedStartPop; currentPop < targetPop; currentPop++) {
      const durationDays = growthDaysForPop(currentPop, bounds.maxPop);
      if (durationDays === undefined) break;
      day += durationDays;
    }
    return day;
  }

  const targetPop = clamp(pop, bounds.minPop, bounds.maxPop);
  if (targetPop <= clampedStartPop) return 1;

  const elapsedDays =
    smoothElapsedDaysAtPopulation(targetPop) -
    smoothElapsedDaysAtPopulation(clampedStartPop);

  return 1 + ceilWithTolerance(elapsedDays);
}

export function populationAtDay(
  day: number,
  startPop: StartingPopulation,
  mode: PopulationMode,
  opts?: PopulationModelOptions
): PopulationAtDayResult {
  validateDay(day);
  validateStartingPopulation(startPop);

  const bounds = resolveBounds(startPop, opts);
  const clampedStartPop = bounds.clampedStartPop;

  if (mode === "step") {
    let popInt = clampedStartPop;
    let currentStepStartDay = 1;

    while (popInt < bounds.maxPop) {
      const durationDays = growthDaysForPop(popInt, bounds.maxPop);
      if (durationDays === undefined) break;

      const nextStepStartDay = currentStepStartDay + durationDays;
      if (day < nextStepStartDay) {
        return {
          popInt,
          progressToNext: (day - currentStepStartDay) / durationDays,
        };
      }

      popInt += 1;
      currentStepStartDay = nextStepStartDay;
    }

    return { popInt: bounds.maxPop, progressToNext: 1 };
  }

  const elapsedDays = day - 1;
  const smoothElapsed =
    smoothElapsedDaysAtPopulation(clampedStartPop) + elapsedDays;
  const popFloat = clamp(
    smoothPopulationAtElapsedDays(smoothElapsed),
    bounds.minPop,
    bounds.maxPop
  );
  const popInt = clamp(floorWithTolerance(popFloat), bounds.minPop, bounds.maxPop);

  return {
    popInt,
    popFloat,
    progressToNext:
      popInt >= bounds.maxPop ? 1 : clamp(popFloat - popInt, 0, 1),
  };
}

export function simulatePopulation(
  days: number,
  startPop: StartingPopulation,
  mode: PopulationMode,
  opts?: PopulationModelOptions
): PopulationAtDayResult[] {
  if (!Number.isFinite(days) || days < 1) {
    throw new Error(`days must be >= 1, got ${days}`);
  }

  const series: PopulationAtDayResult[] = [];
  for (let day = 1; day <= days; day++) {
    series.push(populationAtDay(day, startPop, mode, opts));
  }
  return series;
}
