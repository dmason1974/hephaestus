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
function buildRemainingChain(
  requiredLevels: Record<string, number>,
  currentLevels: Partial<Record<string, number>>,
  buildings: BuildingsFile
): MilitaryInfraStep[] {
  // mercenary_outpost is deliberately absent — it can only be built in a province,
  // never in a city, so it must never appear in a city's infra chain.
  const CHAIN_ORDER = [
    "arms_industry",
    "army_base",
    "air_base",
    "secret_weapons_lab",
    "recruiting_office",
  ];

  const steps: MilitaryInfraStep[] = [];
  const orderedBuildings = [
    ...CHAIN_ORDER.filter(id => id in requiredLevels),
    ...Object.keys(requiredLevels).filter(
      id => !CHAIN_ORDER.includes(id) && id !== "mercenary_outpost"
    ),
  ];

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
 */
export function computeFlipPoint(
  cityEcoResult: CityEcoResult,
  requiredLevels: Record<string, number>,
  mobilisationWindowHours: number,
  deadlineAbsHour: number,
  scenarioAbsHour: number,
  buildings: BuildingsFile,
  maxIterations = 4
): FlipPointResult {
  const { buildingLevelsAtAbsHour } = cityEcoResult;

  // Bootstrap: assume eco built nothing military → full chain from starting levels
  const startingLevels = cityEcoResult.startingLevels as Partial<Record<string, number>>;
  let currentChain = buildRemainingChain(requiredLevels, startingLevels, buildings);
  let remainingBuildHours = currentChain.reduce((s, step) => s + step.buildTimeHours, 0);
  let flipAbsHour = deadlineAbsHour - mobilisationWindowHours - remainingBuildHours;
  let iterations = 0;

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1;
    const prev = flipAbsHour;
    const ecoLevels = buildingLevelsAtAbsHour(Math.max(flipAbsHour, scenarioAbsHour));
    const newChain = buildRemainingChain(requiredLevels, ecoLevels as Partial<Record<string, number>>, buildings);
    const newRemainingHours = newChain.reduce((s, step) => s + step.buildTimeHours, 0);
    flipAbsHour = deadlineAbsHour - mobilisationWindowHours - newRemainingHours;
    currentChain = newChain;
    remainingBuildHours = newRemainingHours;

    if (Math.abs(flipAbsHour - prev) < 0.5) break;
  }

  const feasible = flipAbsHour >= scenarioAbsHour;
  const safeFlipAbsHour = Math.max(flipAbsHour, scenarioAbsHour);
  const ecoBuildingsAtFlip = buildingLevelsAtAbsHour(safeFlipAbsHour) as Partial<Record<string, number>>;
  const finalChain = buildRemainingChain(requiredLevels, ecoBuildingsAtFlip, buildings);
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
