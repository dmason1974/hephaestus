import type { UnitCatalog } from "../../schemas/unit-schema.js";
import type { ScenarioFile } from "../../schemas/scenario-schema.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import { getAvailableLevels } from "./types.js";
import type { ResearchSchedule } from "./types.js";

export type ResearchScheduleInput = {
  unitId: string;
  unitCatalog: UnitCatalog;
  scenario: ScenarioFile;
  deadlineHour: number;
  researchSlots?: number;
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
  const { unitId, unitCatalog, scenario, deadlineHour, researchSlots = 2 } = input;

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
  
  // Track when each research slot becomes available
  const slotAvailableAt: number[] = Array(researchSlots).fill(scenarioStartHour);
  
  let maxLevelAchievable = 0;
  let totalResearchHours = 0;

  // Track when the previous level completes (for sequential dependency)
  let previousLevelEndHour = scenarioStartHour;

  for (const level of availableLevels) {
    const levelData = unit.levels[String(level)];
    if (!levelData?.research) {
      throw new Error(`Unit ${unitId} level ${level} has no research data`);
    }

    // Calculate when this level can start research
    const unlockDay = levelData.research.unlock_day ?? 1;
    const unlockHour = scenarioStartHour + (unlockDay - 1) * 24;
    
    // Find the earliest available slot
    const earliestSlot = Math.min(...slotAvailableAt);
    
    // Must wait for: previous level to complete, unlock day, and an available slot
    const startHour = Math.max(earliestSlot, unlockHour, previousLevelEndHour);
    
    // Calculate research duration
    const researchTime = levelData.research.time;
    const durationHours = 
      (researchTime.days ?? 0) * 24 +
      (researchTime.hours ?? 0) +
      (researchTime.minutes ?? 0) / 60 +
      (researchTime.seconds ?? 0) / 3600;
    
    const endHour = startHour + durationHours;
    
    // Check if this level can complete before deadline
    if (endHour > deadlineHour) {
      break; // Can't research this level in time
    }
    
    // Schedule this level
    schedule.push({
      level,
      startHour,
      endHour,
    });
    
    // Update the slot that was used
    const slotIndex = slotAvailableAt.indexOf(earliestSlot);
    slotAvailableAt[slotIndex] = endHour;
    
    // Track when this level completes for the next level's dependency
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
  const { unitId, unitCatalog, scenario, deadlineHour, researchSlots = 2 } = input;
  
  if (schedule.length === 0) {
    return false;
  }

  const unit = unitCatalog.units[unitId];
  if (!unit) {
    return false;
  }

  const scenarioStartHour = scenarioStartAbsoluteHour(scenario);
  
  // Check each level in sequence
  for (let i = 0; i < schedule.length; i++) {
    const entry = schedule[i];
    const levelData = unit.levels[String(entry.level)];
    
    if (!levelData?.research) {
      return false;
    }

    // Verify unlock day constraint
    const unlockDay = levelData.research.unlock_day ?? 1;
    const unlockHour = scenarioStartHour + (unlockDay - 1) * 24;
    if (entry.startHour < unlockHour) {
      return false;
    }

    // Verify deadline constraint
    if (entry.endHour > deadlineHour) {
      return false;
    }

    // Verify sequential ordering (level N must complete before level N+1 starts)
    if (i > 0 && entry.level > schedule[i - 1].level) {
      if (entry.startHour < schedule[i - 1].endHour) {
        return false;
      }
    }
  }

  // Verify research slot constraint (no more than N levels researching simultaneously)
  const events: Array<{ hour: number; type: 'start' | 'end' }> = [];
  for (const entry of schedule) {
    events.push({ hour: entry.startHour, type: 'start' });
    events.push({ hour: entry.endHour, type: 'end' });
  }
  events.sort((a, b) => a.hour - b.hour || (a.type === 'end' ? -1 : 1));

  let activeResearch = 0;
  for (const event of events) {
    if (event.type === 'start') {
      activeResearch++;
      if (activeResearch > researchSlots) {
        return false;
      }
    } else {
      activeResearch--;
    }
  }

  return true;
}

// Made with Bob
