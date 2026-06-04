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
  doctrine: string;
};

export type ResearchScheduleResult = {
  schedule: ResearchSchedule;
  maxLevelAchievable: number;
  totalResearchHours: number;
  feasible: boolean;
};

type LevelInfo = { level: number; unlockHour: number; durationHours: number };

/**
 * Generates a research schedule that maximises the unit level achievable before the
 * deadline while minimising upkeep cost:
 *
 *   - Level 1 is scheduled ASAP so mobilisation can begin as early as possible.
 *   - Levels 2+ are scheduled JIT (as late as possible before the deadline) so units
 *     at higher levels are mobilised close to the truce end and pay minimum upkeep.
 *
 * @param input Research schedule parameters
 * @returns Research schedule with max achievable level
 */
export function optimizeResearchSchedule(input: ResearchScheduleInput): ResearchScheduleResult {
  const { unitId, unitCatalog, scenario, deadlineHour, doctrine } = input;

  const unit = unitCatalog.units[unitId];
  if (!unit) {
    throw new Error(`Unknown unit: ${unitId}`);
  }

  const availableLevels = getAvailableLevels(unitId, unitCatalog);
  if (availableLevels.length === 0) {
    throw new Error(`Unit ${unitId} has no levels defined`);
  }

  const scenarioStartHour = scenarioStartAbsoluteHour(scenario);
  const unlockedThroughDayAtStart = scenarioResearchUnlockedThroughDayAtStart(scenario);

  // Forward ASAP pass — determines which levels can be achieved before the deadline.
  const achievableLevels: LevelInfo[] = [];
  let previousEndHour = scenarioStartHour;

  for (const level of availableLevels) {
    const levelData = unit.levels[String(level)];
    const researchData = levelData?.research[doctrine];
    if (!researchData) {
      throw new Error(`Unit ${unitId} level ${level} has no research data for doctrine "${doctrine}"`);
    }

    const unlockDay = researchData.unlock_day;
    const effectiveUnlockDay = Math.max(1, unlockDay - unlockedThroughDayAtStart);
    const unlockHour = scenarioStartHour + (effectiveUnlockDay - 1) * 24;
    const durationHours = durationToHours(researchData.time);

    const asapStart = Math.max(unlockHour, previousEndHour);
    const asapEnd = asapStart + durationHours;

    if (asapEnd > deadlineHour) {
      break;
    }

    achievableLevels.push({ level, unlockHour, durationHours });
    previousEndHour = asapEnd;
  }

  if (achievableLevels.length === 0) {
    return { schedule: [], maxLevelAchievable: 0, totalResearchHours: 0, feasible: false };
  }

  // Level 1: schedule ASAP to unlock mobilisation as early as possible.
  const first = achievableLevels[0];
  const start1 = Math.max(first.unlockHour, scenarioStartHour);
  const end1 = start1 + first.durationHours;
  const schedule: ResearchSchedule = [{ level: first.level, startHour: start1, endHour: end1 }];
  let totalResearchHours = first.durationHours;

  if (achievableLevels.length > 1) {
    // Levels 2+: JIT backward pass — push each level as late as possible so units
    // at higher levels are mobilised close to the truce end and pay minimum upkeep.
    const rest = achievableLevels.slice(1);
    const jitEntries: Array<{ level: number; startHour: number; endHour: number; durationHours: number }> = [];

    let upperBound = deadlineHour;
    for (let i = rest.length - 1; i >= 0; i--) {
      const info = rest[i];
      let startHour = upperBound - info.durationHours;
      startHour = Math.max(startHour, info.unlockHour);
      const endHour = startHour + info.durationHours;
      jitEntries.unshift({ level: info.level, startHour, endHour, durationHours: info.durationHours });
      upperBound = startHour;
    }

    // Forward adjustment: each level must start after the previous level ends.
    // (Occurs when the JIT gap between level 1 and level 2 is smaller than level 1's duration.)
    let prevEnd = end1;
    for (const entry of jitEntries) {
      if (entry.startHour < prevEnd) {
        entry.startHour = prevEnd;
        entry.endHour = prevEnd + entry.durationHours;
      }
      prevEnd = entry.endHour;
      schedule.push({ level: entry.level, startHour: entry.startHour, endHour: entry.endHour });
      totalResearchHours += entry.durationHours;
    }
  }

  const maxLevelAchievable = achievableLevels[achievableLevels.length - 1].level;

  return {
    schedule,
    maxLevelAchievable,
    totalResearchHours,
    feasible: true,
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
  const { unitId, unitCatalog, scenario, deadlineHour, doctrine } = input;

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

    const researchData = levelData?.research[doctrine];
    if (!researchData) {
      return false;
    }

    const unlockDay = researchData.unlock_day;
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
