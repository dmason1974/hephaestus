import type { UnitCatalog } from "../../schemas/unit-schema.js";
import type { ScenarioFile } from "../../schemas/scenario-schema.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import { scenarioResearchUnlockedThroughDayAtStart } from "../../schemas/scenario-schema.js";
import { durationToHours } from "../timing/activity-duration.js";
import { getAvailableLevels } from "./types.js";
import type { ResearchSchedule } from "./types.js";

export type ResearchScheduleInput = {
  unitId: string;
  unitCatalog: UnitCatalog;
  scenario: ScenarioFile;
  deadlineHour: number;
};

export type ResearchScheduleResult = {
  schedule: ResearchSchedule;
  maxLevelAchievable: number;
  totalResearchHours: number;
  feasible: boolean;
};

/**
 * Generates a greedy research schedule that maximizes the unit level achievable before the deadline.
 * 
 * Strategy:
 * - Research levels sequentially from 1 to max
 * - Respect unlock_day constraints
 * - Use all available research slots in parallel
 * - Stop when next level would exceed deadline
 * 
 * @param input Research schedule parameters
 * @returns Research schedule with max achievable level
 */
export function optimizeResearchSchedule(input: ResearchScheduleInput): ResearchScheduleResult {
  const { unitId, unitCatalog, scenario, deadlineHour } = input;

  const unit = unitCatalog.units[unitId];
  if (!unit) {
    throw new Error(`Unknown unit: ${unitId}`);
  }

  const availableLevels = getAvailableLevels(unitId, unitCatalog);
  if (availableLevels.length === 0) {
    throw new Error(`Unit ${unitId} has no levels defined`);
  }

  const schedule: ResearchSchedule = [];
  const scenarioStartHour = scenarioStartAbsoluteHour(scenario);
  const unlockedThroughDayAtStart = scenarioResearchUnlockedThroughDayAtStart(scenario);

  let maxLevelAchievable = 0;
  let totalResearchHours = 0;
  let previousLevelEndHour = scenarioStartHour;

  for (const level of availableLevels) {
    const levelData = unit.levels[String(level)];
    if (!levelData?.research) {
      throw new Error(`Unit ${unitId} level ${level} has no research data`);
    }

    const unlockDay = levelData.research.unlock_day ?? 1;
    const effectiveUnlockDay = Math.max(1, unlockDay - unlockedThroughDayAtStart);
    const unlockHour = scenarioStartHour + (effectiveUnlockDay - 1) * 24;

    // Each level must wait for the previous level to complete and its own unlock gate
    const startHour = Math.max(unlockHour, previousLevelEndHour);

    const durationHours = durationToHours(levelData.research.time);
    const endHour = startHour + durationHours;

    if (endHour > deadlineHour) {
      break;
    }

    schedule.push({ level, startHour, endHour });

    previousLevelEndHour = endHour;
    maxLevelAchievable = level;
    totalResearchHours += durationHours;
  }

  return {
    schedule,
    maxLevelAchievable,
    totalResearchHours,
    feasible: maxLevelAchievable > 0,
  };
}

/**
 * Validates that a research schedule is feasible given the constraints.
 * 
 * @param schedule Research schedule to validate
 * @param input Research parameters
 * @returns True if schedule is valid
 */
export function validateResearchSchedule(
  schedule: ResearchSchedule,
  input: ResearchScheduleInput
): boolean {
  const { unitId, unitCatalog, scenario, deadlineHour } = input;

  if (schedule.length === 0) {
    return false;
  }

  const unit = unitCatalog.units[unitId];
  if (!unit) {
    return false;
  }

  const scenarioStartHour = scenarioStartAbsoluteHour(scenario);
  const unlockedThroughDayAtStart = scenarioResearchUnlockedThroughDayAtStart(scenario);

  for (let i = 0; i < schedule.length; i++) {
    const entry = schedule[i];
    const levelData = unit.levels[String(entry.level)];

    if (!levelData?.research) {
      return false;
    }

    const unlockDay = levelData.research.unlock_day ?? 1;
    const effectiveUnlockDay = Math.max(1, unlockDay - unlockedThroughDayAtStart);
    const unlockHour = scenarioStartHour + (effectiveUnlockDay - 1) * 24;
    if (entry.startHour < unlockHour) {
      return false;
    }

    if (entry.endHour > deadlineHour) {
      return false;
    }

    // Each level must start after the previous level completes
    if (i > 0 && entry.startHour < schedule[i - 1].endHour) {
      return false;
    }
  }

  return true;
}

// Made with Bob
