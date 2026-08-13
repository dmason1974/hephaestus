import { buildTimeToMinutes } from "../orchestration/build-order-timeline.js";
import type { BuildingsFile } from "../../schemas/building-schema.js";
import type { CityEcoResult } from "./city-eco-beam.js";

export type MilitaryInfraStep = {
  buildingId: string;
  fromLevel: number;
  toLevel: number;
  buildTimeHours: number;
};

export type FlipPointResult = {
  feasible: boolean;
  flipPointAbsHour: number;
  flipPointRelHour: number;
  /** Building levels from eco at the flip point (includes starting levels) */
  ecoBuildingsAtFlip: Partial<Record<string, number>>;
  /** Military build steps remaining after the flip point */
  remainingChain: MilitaryInfraStep[];
  remainingBuildHours: number;
  mobilisationWindowHours: number;
  /** Absolute hour when mobilisation can first start (= flipPoint + remainingBuildHours) */
  mobilisationStartAbsHour: number;
  /** Iterations run to converge */
  iterations: number;
};

/** Parse a unit requirement string like "air_base level 5" → {buildingId, level}. */
function parseRequirement(req: string): { buildingId: string; level: number } | null {
  const match = req.match(/^([\w]+(?:_[\w]+)*) level (\d+)$/);
  if (!match) return null;
  return { buildingId: match[1], level: parseInt(match[2], 10) };
}

/** Convert unit requirement strings to a building-level map (max level per building). */
export function requirementsToLevelMap(requirements: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const req of requirements) {
    const parsed = parseRequirement(req);
    if (!parsed) continue;
    map[parsed.buildingId] = Math.max(map[parsed.buildingId] ?? 0, parsed.level);
  }
  return map;
}

/** Build time for one level of a building, in game hours. Returns 0 if not found. */
function buildingLevelHours(buildings: BuildingsFile, buildingId: string, level: number): number {
  const data = buildings.buildings[buildingId]?.levels[String(level) as "1" | "2" | "3" | "4" | "5"];
  if (!data?.build_time) return 0;
  return buildTimeToMinutes(data.build_time) / 60;
}

/**
 * Compute the sequential military build chain from current levels to required levels.
 * Only includes buildings present in `requiredLevels` that still need work.
 * The chain is ordered by the standard military build sequence.
 */
// mercenary_outpost is deliberately absent — it can only be built in a province,
// never in a city, so it must never appear in a city's infra chain.
const CHAIN_ORDER = [
  "arms_industry",
  "army_base",
  "air_base",
  "secret_weapons_lab",
  "recruiting_office",
];

function defaultOrderBuildings(ids: string[]): string[] {
  return [
    ...CHAIN_ORDER.filter(id => ids.includes(id)),
    ...ids.filter(id => !CHAIN_ORDER.includes(id) && id !== "mercenary_outpost"),
  ];
}

function buildRemainingChain(
  requiredLevels: Record<string, number>,
  currentLevels: Partial<Record<string, number>>,
  buildings: BuildingsFile,
  orderBuildings: (ids: string[]) => string[] = defaultOrderBuildings
): MilitaryInfraStep[] {
  const steps: MilitaryInfraStep[] = [];
  const orderedBuildings = orderBuildings(
    Object.keys(requiredLevels).filter(id => id !== "mercenary_outpost")
  );

  for (const buildingId of orderedBuildings) {
    const targetLevel = requiredLevels[buildingId] ?? 0;
    const currentLevel = currentLevels[buildingId] ?? 0;
    for (let lv = currentLevel + 1; lv <= targetLevel; lv++) {
      steps.push({
        buildingId,
        fromLevel: lv - 1,
        toLevel: lv,
        buildTimeHours: buildingLevelHours(buildings, buildingId, lv),
      });
    }
  }

  return steps;
}

/**
 * Compute the optimal flip point for a city given its eco result and military requirements.
 *
 * Uses iterative convergence (typically 1-2 rounds):
 *   flipPoint = deadline − mobilisationWindowHours − remainingBuildHours(ecoAtFlipPoint)
 *
 * @param cityEcoResult - eco beam result for this city
 * @param requiredLevels - required building levels for the military role (e.g. {air_base: 5, secret_weapons_lab: 1})
 * @param mobilisationWindowHours - game hours needed to mobilise all units from this city
 * @param deadlineAbsHour - absolute game hour of the truce deadline
 * @param scenarioAbsHour - absolute game hour of scenario start
 * @param buildings - buildings data file
 * @param maxIterations - convergence iteration cap
 * @param orderBuildings - optional custom build ordering (default: CHAIN_ORDER-based).
 *   E.g. callers that need recruiting_office forced first can supply their own.
 */
export function computeFlipPoint(
  cityEcoResult: CityEcoResult,
  requiredLevels: Record<string, number>,
  mobilisationWindowHours: number,
  deadlineAbsHour: number,
  scenarioAbsHour: number,
  buildings: BuildingsFile,
  maxIterations = 4,
  orderBuildings: (ids: string[]) => string[] = defaultOrderBuildings
): FlipPointResult {
  const { buildingLevelsAtAbsHour } = cityEcoResult;

  // Bootstrap: assume eco built nothing military → full chain from starting levels
  const startingLevels = cityEcoResult.startingLevels as Partial<Record<string, number>>;
  let currentChain = buildRemainingChain(requiredLevels, startingLevels, buildings, orderBuildings);
  let remainingBuildHours = currentChain.reduce((s, step) => s + step.buildTimeHours, 0);
  let flipAbsHour = deadlineAbsHour - mobilisationWindowHours - remainingBuildHours;
  let iterations = 0;

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1;
    const prev = flipAbsHour;
    const ecoLevels = buildingLevelsAtAbsHour(Math.max(flipAbsHour, scenarioAbsHour));
    const newChain = buildRemainingChain(requiredLevels, ecoLevels as Partial<Record<string, number>>, buildings, orderBuildings);
    const newRemainingHours = newChain.reduce((s, step) => s + step.buildTimeHours, 0);
    flipAbsHour = deadlineAbsHour - mobilisationWindowHours - newRemainingHours;
    currentChain = newChain;
    remainingBuildHours = newRemainingHours;

    if (Math.abs(flipAbsHour - prev) < 0.5) break;
  }

  const feasible = flipAbsHour >= scenarioAbsHour;
  const safeFlipAbsHour = Math.max(flipAbsHour, scenarioAbsHour);
  const ecoBuildingsAtFlip = buildingLevelsAtAbsHour(safeFlipAbsHour) as Partial<Record<string, number>>;
  const finalChain = buildRemainingChain(requiredLevels, ecoBuildingsAtFlip, buildings, orderBuildings);
  const finalBuildHours = finalChain.reduce((s, step) => s + step.buildTimeHours, 0);

  return {
    feasible,
    flipPointAbsHour: flipAbsHour,
    flipPointRelHour: flipAbsHour - scenarioAbsHour,
    ecoBuildingsAtFlip,
    remainingChain: finalChain,
    remainingBuildHours: finalBuildHours,
    mobilisationWindowHours,
    mobilisationStartAbsHour: safeFlipAbsHour + finalBuildHours,
    iterations,
  };
}

/**
 * Compute the mobilisation window in game hours for N units across C cities at a given RO level.
 * Assumes morale = 100% (no slowdown) and full-speed production.
 *
 * @param totalUnits - total units to mobilise
 * @param numCities - number of cities producing this unit in parallel
 * @param mobTimeHoursPerUnit - base mob time per unit in game hours (from unit catalog)
 * @param roSpeedBonusPct - recruiting office speed bonus (0.10 = 10%)
 */
export function mobilisationWindowHours(
  totalUnits: number,
  numCities: number,
  mobTimeHoursPerUnit: number,
  roSpeedBonusPct: number
): number {
  if (numCities <= 0) return Number.POSITIVE_INFINITY;
  const effectiveMobHours = mobTimeHoursPerUnit / (1 + roSpeedBonusPct);
  const unitsPerCity = Math.ceil(totalUnits / numCities);
  return unitsPerCity * effectiveMobHours;
}

/** Derive required building levels from unit catalog requirements for a given unit at level 1. */
export function unitBuildingRequirements(
  unitId: string,
  units: Record<string, { levels?: Record<string, { requirements?: string[] }> }>
): Record<string, number> {
  const l1 = units[unitId]?.levels?.["1"];
  if (!l1?.requirements) return {};
  return requirementsToLevelMap(l1.requirements);
}

// ── Idle-window backfill ─────────────────────────────────────────────────────
//
// Unit 1.5's eco beam stops adding buildings once nothing scores positively under
// the plan's resource weights, leaving a city's build queue genuinely idle for
// however long remains until the (independently computed) flip point. Buildings
// the military phase already knows it needs (`requiredLevels`) are guaranteed to
// be built anyway — pulling them into that idle window has zero downside (a
// city's own resource production doesn't depend on what's in its build queue), it
// only lands their bonus (e.g. recruiting_office's manpower bonus) earlier.

export type EcoBackfillStep = MilitaryInfraStep & {
  /** Absolute game hour the backfilled build starts/ends — real timestamps. */
  startHour: number;
  endHour: number;
};

/**
 * Fills the idle window between a city's last organic eco build
 * (`cityEcoResult.lastEcoBuildCompletionAbsHour`) and `windowEndAbsHour` with
 * guaranteed future building levels (`requiredLevels`) the eco beam never chose to
 * build because they didn't score positively.
 *
 * Greedy, priority-order, no skip-ahead: walks `orderBuildings`'s ordering and
 * schedules each required level sequentially if its full build time fits before
 * `windowEndAbsHour`; stops entirely at the first level that doesn't fit (a city
 * has one sequential build queue slot — skipping ahead to a smaller lower-priority
 * item would fight the same ordering convention used for the post-flip chain).
 */
export function computeEcoBackfill(
  cityEcoResult: CityEcoResult,
  requiredLevels: Record<string, number>,
  windowEndAbsHour: number,
  buildings: BuildingsFile,
  orderBuildings: (ids: string[]) => string[] = defaultOrderBuildings
): EcoBackfillStep[] {
  const startHour = cityEcoResult.lastEcoBuildCompletionAbsHour;
  if (windowEndAbsHour <= startHour) return [];

  const currentLevels: Partial<Record<string, number>> = {
    ...(cityEcoResult.buildingLevelsAtAbsHour(startHour) as Partial<Record<string, number>>),
  };
  const orderedIds = orderBuildings(
    Object.keys(requiredLevels).filter(id => id !== "mercenary_outpost")
  );

  const steps: EcoBackfillStep[] = [];
  let cur = startHour;

  outer: for (const buildingId of orderedIds) {
    const targetLevel = requiredLevels[buildingId] ?? 0;
    let level = currentLevels[buildingId] ?? 0;
    while (level < targetLevel) {
      const nextLevel = level + 1;
      const dur = buildingLevelHours(buildings, buildingId, nextLevel);
      if (dur <= 0 || cur + dur > windowEndAbsHour) break outer;
      steps.push({ buildingId, fromLevel: level, toLevel: nextLevel, buildTimeHours: dur, startHour: cur, endHour: cur + dur });
      cur += dur;
      level = nextLevel;
      currentLevels[buildingId] = level;
    }
  }

  return steps;
}

/**
 * Wraps a `CityEcoResult` so `buildingLevelsAtAbsHour` also credits backfilled
 * levels once their (real, absolute) completion hour has passed — same semantics
 * as the organic function's own "credited once built" check. Feeding this
 * augmented result into `computeFlipPoint` is what makes the convergence loop
 * "see" the backfilled work: `buildRemainingChain` naturally excludes any level
 * already credited here, so the eco-planner-slot placement always wins over the
 * post-flip chain — no separate de-dup pass needed.
 */
export function withBackfilledLevels(
  cityEcoResult: CityEcoResult,
  backfillSteps: EcoBackfillStep[]
): CityEcoResult {
  if (backfillSteps.length === 0) return cityEcoResult;
  return {
    ...cityEcoResult,
    buildingLevelsAtAbsHour: (absHour: number) => {
      const levels = { ...cityEcoResult.buildingLevelsAtAbsHour(absHour) } as Partial<Record<string, number>>;
      for (const step of backfillSteps) {
        if (step.endHour <= absHour) {
          levels[step.buildingId] = Math.max(levels[step.buildingId] ?? 0, step.toLevel);
        }
      }
      return levels as ReturnType<CityEcoResult["buildingLevelsAtAbsHour"]>;
    },
  };
}
