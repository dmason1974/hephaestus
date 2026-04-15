import { toAbsoluteHour, type ScenarioStartLike } from "../../core/time.js";
import type { Resource } from "../../core/constants.js";
import type { UnitCatalog } from "../../schemas/unit-schema.js";
import {
  scenarioResearchUnlockedThroughDayAtStart,
  scenarioTruceLengthDays,
  type ScenarioFile,
} from "../../schemas/scenario-schema.js";

export type UnitResearchAction = {
  unitId: string;
  targetLevel: number;
};

export type UnitResearchTargets = Record<string, number>;

export type UnitResearchSegment = {
  unitId: string;
  level: number;
  slot: number;
  unlockDay: number;
  startAbsoluteHour: number;
  endAbsoluteHourExclusive: number;
  durationHours: number;
  cost: Record<Resource, number>;
};

export type UnitResearchSimulationResult = {
  segments: UnitResearchSegment[];
  spendingByAbsoluteHour: Array<{
    absoluteHour: number;
    cost: Record<Resource, number>;
  }>;
  totals: Record<Resource, number>;
};

type ResearchScenarioLike = ScenarioStartLike & Partial<Pick<ScenarioFile, "research">>;
type ResearchPlanningScenarioLike = ScenarioStartLike & Partial<Pick<ScenarioFile, "research" | "truce_length_days">>;

function zeroResources(): Record<Resource, number> {
  return {
    supplies: 0,
    components: 0,
    fuel: 0,
    rares: 0,
    electronics: 0,
    cash: 0,
    manpower: 0,
  };
}

function durationHours(time: {
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
}) {
  return (
    ((time.days ?? 0) * 24) +
    (time.hours ?? 0) +
    ((time.minutes ?? 0) / 60) +
    ((time.seconds ?? 0) / 3600)
  );
}

function normalizeDurationHours(hours: number) {
  if (!Number.isFinite(hours) || hours < 0) {
    throw new Error(`research duration must be >= 0, got ${hours}`);
  }

  // Keep scheduling aligned to whole-hour economy accounting.
  return Math.ceil(hours);
}

function normalizeSlotCount(slots?: number) {
  return Math.max(1, Math.floor(slots ?? 2));
}

function researchUnlockAbsoluteHour(
  scenario: ResearchScenarioLike,
  unlockDay: number
) {
  const scenarioStartHour = toAbsoluteHour(scenario.start.day, scenario.start.hour);
  const unlockedThroughDayAtStart = scenarioResearchUnlockedThroughDayAtStart(
    scenario as ScenarioFile
  );

  const effectiveUnlockDay = Math.max(1, unlockDay - unlockedThroughDayAtStart + 1);

  if (effectiveUnlockDay <= scenario.start.day) {
    return scenarioStartHour;
  }

  return toAbsoluteHour(effectiveUnlockDay, 0);
}

function researchDeadlineAbsoluteHour(
  scenario: ResearchPlanningScenarioLike
) {
  const truceLengthDays = scenarioTruceLengthDays(scenario as ScenarioFile);
  if (truceLengthDays === undefined) return undefined;

  return toAbsoluteHour(scenario.start.day, scenario.start.hour) + (truceLengthDays * 24);
}

function parseLevelRequirement(requirement: string) {
  const match = requirement.trim().match(/^(.+?)\s+level\s+(\d+)$/i);
  if (!match) return null;

  return {
    id: match[1].trim(),
    level: Number(match[2]),
  };
}

function requiredUnitLevelsForResearchLevel(
  catalog: UnitCatalog,
  unitId: string,
  level: number
) {
  const unit = catalog.units[unitId];
  if (!unit) {
    throw new Error(`unknown unit "${unitId}" while resolving research requirements`);
  }

  const levelData = unit.levels[String(level)];
  if (!levelData) {
    throw new Error(`missing research data for ${unitId} level ${level}`);
  }

  const requirements = new Map<string, number>();
  for (const requirement of levelData.requirements) {
    const parsed = parseLevelRequirement(requirement);
    if (!parsed) continue;
    if (!catalog.units[parsed.id]) continue;

    requirements.set(parsed.id, Math.max(requirements.get(parsed.id) ?? 0, parsed.level));
  }

  return requirements;
}

function unitLevelImpactScore(
  catalog: UnitCatalog,
  unitId: string,
  level: number
) {
  const unit = catalog.units[unitId];
  const current = unit?.levels[String(level)];
  if (!unit || !current) {
    throw new Error(`missing unit data for ${unitId} level ${level}`);
  }

  const previous = level > 1 ? unit.levels[String(level - 1)] : undefined;
  const mobilisationResources = Object.values(current.mobilisation.cost).reduce((sum, value) => sum + value, 0);
  const upkeepResources = Object.values(current.daily_upkeep.cost).reduce((sum, value) => sum + value, 0);

  if (!previous) {
    return mobilisationResources + (upkeepResources * 24);
  }

  const previousMobilisation = Object.values(previous.mobilisation.cost).reduce((sum, value) => sum + value, 0);
  const previousUpkeep = Object.values(previous.daily_upkeep.cost).reduce((sum, value) => sum + value, 0);

  const deltaMobilisation = mobilisationResources - previousMobilisation;
  const deltaUpkeep = (upkeepResources - previousUpkeep) * 24;
  return Math.max(1, deltaMobilisation + deltaUpkeep);
}

function expandTargetsWithUnitRequirements(
  catalog: UnitCatalog,
  targets: UnitResearchTargets
) {
  const expanded = new Map<string, number>();
  const queue = Object.entries(targets).map(([unitId, targetLevel]) => ({
    unitId,
    targetLevel: Math.floor(targetLevel),
  }));

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) continue;

    const unit = catalog.units[next.unitId];
    if (!unit) {
      throw new Error(`unknown unit "${next.unitId}" in research targets`);
    }
    if (!Number.isFinite(next.targetLevel) || next.targetLevel < 0) {
      throw new Error(`target level for ${next.unitId} must be >= 0, got ${next.targetLevel}`);
    }

    const currentTarget = expanded.get(next.unitId) ?? 0;
    if (next.targetLevel <= currentTarget) continue;

    expanded.set(next.unitId, next.targetLevel);

    for (let level = currentTarget + 1; level <= next.targetLevel; level++) {
      const requirements = requiredUnitLevelsForResearchLevel(catalog, next.unitId, level);
      for (const [requiredUnitId, requiredLevel] of requirements.entries()) {
        const existingRequiredLevel = expanded.get(requiredUnitId) ?? 0;
        if (requiredLevel > existingRequiredLevel) {
          queue.push({
            unitId: requiredUnitId,
            targetLevel: requiredLevel,
          });
        }
      }
    }
  }

  return expanded;
}

function accumulateResearchCost(
  totals: Record<Resource, number>,
  spendingByHour: Map<number, Record<Resource, number>>,
  absoluteHour: number,
  cost: Record<Resource, number>
) {
  const hourCost = spendingByHour.get(absoluteHour) ?? zeroResources();
  for (const resource of Object.keys(totals) as Resource[]) {
    hourCost[resource] += cost[resource];
    totals[resource] += cost[resource];
  }
  spendingByHour.set(absoluteHour, hourCost);
}

export function simulateUnitResearchQueue(
  catalog: UnitCatalog,
  actions: UnitResearchAction[],
  scenario: ResearchScenarioLike,
  opts?: {
    slots?: number;
  }
): UnitResearchSimulationResult {
  const segments: UnitResearchSegment[] = [];
  const totals = zeroResources();
  const spendingByHour = new Map<number, Record<Resource, number>>();
  const currentLevelByUnit = new Map<string, number>();
  const scenarioStartHour = toAbsoluteHour(scenario.start.day, scenario.start.hour);
  const slotCount = normalizeSlotCount(opts?.slots);
  const slotAvailableAt = Array.from({ length: slotCount }, () => scenarioStartHour);

  for (const action of actions) {
    const unit = catalog.units[action.unitId];
    if (!unit) {
      throw new Error(`unknown unit "${action.unitId}" in research queue`);
    }

    const currentLevel = currentLevelByUnit.get(action.unitId) ?? 0;
    if (action.targetLevel <= currentLevel) {
      throw new Error(
        `research target for ${action.unitId} must be above current queued level ${currentLevel}, got ${action.targetLevel}`
      );
    }

    for (let level = currentLevel + 1; level <= action.targetLevel; level++) {
      const levelData = unit.levels[String(level)];
      if (!levelData) {
        throw new Error(`missing research data for ${action.unitId} level ${level}`);
      }

      const unlockAbsoluteHour = researchUnlockAbsoluteHour(scenario, levelData.research.unlock_day);
      let selectedSlot = 0;
      for (let slot = 1; slot < slotAvailableAt.length; slot++) {
        if (slotAvailableAt[slot] < slotAvailableAt[selectedSlot]) {
          selectedSlot = slot;
        }
      }

      const startAbsoluteHour = Math.max(
        slotAvailableAt[selectedSlot],
        unlockAbsoluteHour,
        scenarioStartHour
      );
      const projectDurationHours = normalizeDurationHours(durationHours(levelData.research.time));
      const endAbsoluteHourExclusive = startAbsoluteHour + projectDurationHours;

      segments.push({
        unitId: action.unitId,
        level,
        slot: selectedSlot + 1,
        unlockDay: levelData.research.unlock_day,
        startAbsoluteHour,
        endAbsoluteHourExclusive,
        durationHours: projectDurationHours,
        cost: { ...levelData.research.cost },
      });

      accumulateResearchCost(totals, spendingByHour, startAbsoluteHour, levelData.research.cost);

      slotAvailableAt[selectedSlot] = endAbsoluteHourExclusive;
      currentLevelByUnit.set(action.unitId, level);
    }
  }

  return {
    segments,
    spendingByAbsoluteHour: Array.from(spendingByHour.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([absoluteHour, cost]) => ({ absoluteHour, cost })),
    totals,
  };
}

export function simulateUnitResearchTargets(
  catalog: UnitCatalog,
  targets: UnitResearchTargets,
  scenario: ResearchPlanningScenarioLike,
  opts?: {
    slots?: number;
    latestCompletionByUnitLevel?: Record<string, number>;
    unitDemandCounts?: Record<string, number>;
  }
): UnitResearchSimulationResult {
  const scenarioStartHour = toAbsoluteHour(scenario.start.day, scenario.start.hour);
  const deadlineAbsoluteHour = researchDeadlineAbsoluteHour(scenario);
  const expandedTargets = expandTargetsWithUnitRequirements(catalog, targets);
  const slotCount = normalizeSlotCount(opts?.slots);

  if (deadlineAbsoluteHour === undefined) {
    const segments: UnitResearchSegment[] = [];
    const totals = zeroResources();
    const spendingByHour = new Map<number, Record<Resource, number>>();
    const slotAvailableAt = Array.from({ length: slotCount }, () => scenarioStartHour);
    const nextLevelByUnit = new Map<string, number>();
    const remainingUnits = new Set<string>();
    const completedAtByUnitLevel = new Map<string, number>();

    for (const [unitId, targetLevel] of expandedTargets.entries()) {
      if (targetLevel <= 0) continue;
      nextLevelByUnit.set(unitId, 1);
      remainingUnits.add(unitId);
    }

    while (remainingUnits.size > 0) {
      let selectedUnitId: string | null = null;
      let selectedLevel = -1;
      let selectedSlot = -1;
      let selectedStartHour = Number.POSITIVE_INFINITY;

      for (const unitId of remainingUnits) {
        const level = nextLevelByUnit.get(unitId);
        const targetLevel = expandedTargets.get(unitId) ?? 0;
        if (level === undefined || level > targetLevel) {
          remainingUnits.delete(unitId);
          continue;
        }

        const unit = catalog.units[unitId];
        const levelData = unit?.levels[String(level)];
        if (!unit || !levelData) {
          throw new Error(`missing research data for ${unitId} level ${level}`);
        }

        const unlockAbsoluteHour = researchUnlockAbsoluteHour(scenario, levelData.research.unlock_day);
        const requiredUnits = requiredUnitLevelsForResearchLevel(catalog, unitId, level);
        let prerequisiteReadyHour = scenarioStartHour;
        let missingRequirement = false;

        for (const [requiredUnitId, requiredLevel] of requiredUnits.entries()) {
          const completedAt = completedAtByUnitLevel.get(`${requiredUnitId}:${requiredLevel}`);
          if (completedAt === undefined) {
            missingRequirement = true;
            break;
          }
          prerequisiteReadyHour = Math.max(prerequisiteReadyHour, completedAt);
        }
        if (missingRequirement) continue;

        for (let slot = 0; slot < slotAvailableAt.length; slot++) {
          const candidateStartHour = Math.max(
            slotAvailableAt[slot],
            unlockAbsoluteHour,
            prerequisiteReadyHour,
            scenarioStartHour
          );

          const isBetter =
            candidateStartHour < selectedStartHour ||
            (
              candidateStartHour === selectedStartHour &&
              (selectedUnitId === null || unitId.localeCompare(selectedUnitId) < 0)
            ) ||
            (
              candidateStartHour === selectedStartHour &&
              unitId === selectedUnitId &&
              slot < selectedSlot
            );

          if (isBetter) {
            selectedUnitId = unitId;
            selectedLevel = level;
            selectedSlot = slot;
            selectedStartHour = candidateStartHour;
          }
        }
      }

      if (selectedUnitId === null || selectedSlot < 0 || !Number.isFinite(selectedStartHour)) {
        throw new Error("failed to build research plan from targets");
      }

      const selectedUnit = catalog.units[selectedUnitId];
      const selectedLevelData = selectedUnit?.levels[String(selectedLevel)];
      if (!selectedUnit || !selectedLevelData) {
        throw new Error(`missing research data for ${selectedUnitId} level ${selectedLevel}`);
      }

      const duration = normalizeDurationHours(durationHours(selectedLevelData.research.time));
      const endAbsoluteHourExclusive = selectedStartHour + duration;

      segments.push({
        unitId: selectedUnitId,
        level: selectedLevel,
        slot: selectedSlot + 1,
        unlockDay: selectedLevelData.research.unlock_day,
        startAbsoluteHour: selectedStartHour,
        endAbsoluteHourExclusive,
        durationHours: duration,
        cost: { ...selectedLevelData.research.cost },
      });

      accumulateResearchCost(totals, spendingByHour, selectedStartHour, selectedLevelData.research.cost);
      slotAvailableAt[selectedSlot] = endAbsoluteHourExclusive;
      completedAtByUnitLevel.set(`${selectedUnitId}:${selectedLevel}`, endAbsoluteHourExclusive);

      const nextLevel = selectedLevel + 1;
      const targetLevel = expandedTargets.get(selectedUnitId) ?? 0;
      if (nextLevel > targetLevel) {
        remainingUnits.delete(selectedUnitId);
        nextLevelByUnit.delete(selectedUnitId);
      } else {
        nextLevelByUnit.set(selectedUnitId, nextLevel);
      }
    }

    return {
      segments,
      spendingByAbsoluteHour: Array.from(spendingByHour.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([absoluteHour, cost]) => ({ absoluteHour, cost })),
      totals,
    };
  }

  type PlannedTask = {
    taskId: string;
    unitId: string;
    level: number;
    unlockDay: number;
    releaseHour: number;
    durationHours: number;
    cost: Record<Resource, number>;
    dependencyIds: string[];
    successorIds: string[];
    demandCount: number;
    impactScore: number;
  };

  const totals = zeroResources();
  const spendingByHour = new Map<number, Record<Resource, number>>();
  const plannedTasks = new Map<string, PlannedTask>();

  for (const [unitId, targetLevel] of expandedTargets.entries()) {
    for (let level = 1; level <= targetLevel; level++) {
      const unit = catalog.units[unitId];
      const levelData = unit?.levels[String(level)];
      if (!unit || !levelData) {
        throw new Error(`missing research data for ${unitId} level ${level}`);
      }

      const dependencyIds: string[] = [];
      if (level > 1) {
        dependencyIds.push(`${unitId}:${level - 1}`);
      }

      const requirements = requiredUnitLevelsForResearchLevel(catalog, unitId, level);
      for (const [requiredUnitId, requiredLevel] of requirements.entries()) {
        dependencyIds.push(`${requiredUnitId}:${requiredLevel}`);
      }

      const taskId = `${unitId}:${level}`;
      plannedTasks.set(taskId, {
        taskId,
        unitId,
        level,
        unlockDay: levelData.research.unlock_day,
        releaseHour: researchUnlockAbsoluteHour(scenario, levelData.research.unlock_day),
        durationHours: normalizeDurationHours(durationHours(levelData.research.time)),
        cost: { ...levelData.research.cost },
        dependencyIds,
        successorIds: [],
        demandCount: opts?.unitDemandCounts?.[unitId] ?? 0,
        impactScore: unitLevelImpactScore(catalog, unitId, level),
      });
    }
  }

  function taskPriority(task: PlannedTask) {
    return (task.demandCount * task.impactScore * 1000) + (task.level * 10) + task.impactScore;
  }

  function candidateBeatsCurrent(args: {
    candidateTask: PlannedTask;
    candidateTaskId: string;
    candidateStartHour: number;
    candidateSlot: number;
    selectedTaskId: string | null;
    selectedStartHour: number;
    selectedSlot: number;
  }) {
    if (args.selectedTaskId === null) return true;

    const selectedTask = plannedTasks.get(args.selectedTaskId);
    if (!selectedTask) return true;

    const candidateWeight = taskPriority(args.candidateTask);
    const selectedWeight = taskPriority(selectedTask);
    const startHourGap = Math.abs(args.candidateStartHour - args.selectedStartHour);

    // In a backward planner, heavier research should be kept later when the timing gap is modest.
    if (startHourGap <= 24 && candidateWeight !== selectedWeight) {
      return candidateWeight > selectedWeight;
    }

    if (args.candidateStartHour !== args.selectedStartHour) {
      return args.candidateStartHour > args.selectedStartHour;
    }

    if (candidateWeight !== selectedWeight) {
      return candidateWeight > selectedWeight;
    }

    if (args.candidateTaskId !== args.selectedTaskId) {
      return args.candidateTaskId.localeCompare(args.selectedTaskId) < 0;
    }

    return args.candidateSlot < args.selectedSlot;
  }

  for (const [taskId, task] of plannedTasks.entries()) {
    for (const dependencyId of task.dependencyIds) {
      const dependencyTask = plannedTasks.get(dependencyId);
      if (!dependencyTask) {
        throw new Error(`missing prerequisite task "${dependencyId}" required by ${taskId}`);
      }
      dependencyTask.successorIds.push(taskId);
    }
  }

  const scheduledStarts = new Map<string, number>();
  const scheduledEnds = new Map<string, number>();
  const scheduledSlots = new Map<string, number>();
  const slotFreeBefore = Array.from({ length: slotCount }, () => deadlineAbsoluteHour);
  const unscheduled = new Set(plannedTasks.keys());

  while (unscheduled.size > 0) {
    let selectedTaskId: string | null = null;
    let selectedSlot = -1;
    let selectedStartHour = Number.NEGATIVE_INFINITY;
    let selectedEndHour = Number.NEGATIVE_INFINITY;

    for (const taskId of unscheduled) {
      const task = plannedTasks.get(taskId);
      if (!task) continue;

      const allSuccessorsScheduled = task.successorIds.every(successorId => scheduledStarts.has(successorId));
      if (!allSuccessorsScheduled) continue;

      const successorStartBound =
        Math.min(
          task.successorIds.length > 0
            ? Math.min(...task.successorIds.map(successorId => scheduledStarts.get(successorId) ?? deadlineAbsoluteHour))
            : deadlineAbsoluteHour,
          opts?.latestCompletionByUnitLevel?.[taskId] ?? deadlineAbsoluteHour,
        );

      for (let slot = 0; slot < slotFreeBefore.length; slot++) {
        const candidateEndHour = Math.min(slotFreeBefore[slot], successorStartBound);
        const candidateStartHour = candidateEndHour - task.durationHours;
        if (candidateStartHour < task.releaseHour) continue;

        const isBetter = candidateBeatsCurrent({
          candidateTask: task,
          candidateTaskId: taskId,
          candidateStartHour,
          candidateSlot: slot,
          selectedTaskId,
          selectedStartHour,
          selectedSlot,
        });

        if (isBetter) {
          selectedTaskId = taskId;
          selectedSlot = slot;
          selectedStartHour = candidateStartHour;
          selectedEndHour = candidateEndHour;
        }
      }
    }

    if (selectedTaskId === null || selectedSlot < 0 || !Number.isFinite(selectedStartHour)) {
      throw new Error("failed to build research plan before the scenario truce deadline");
    }

    const selectedTask = plannedTasks.get(selectedTaskId);
    if (!selectedTask) {
      throw new Error(`missing selected research task "${selectedTaskId}"`);
    }

    scheduledStarts.set(selectedTaskId, selectedStartHour);
    scheduledEnds.set(selectedTaskId, selectedEndHour);
    scheduledSlots.set(selectedTaskId, selectedSlot + 1);
    slotFreeBefore[selectedSlot] = selectedStartHour;
    unscheduled.delete(selectedTaskId);
  }

  const segments: UnitResearchSegment[] = Array.from(plannedTasks.values())
    .map(task => ({
      unitId: task.unitId,
      level: task.level,
      slot: scheduledSlots.get(task.taskId) ?? 1,
      unlockDay: task.unlockDay,
      startAbsoluteHour: scheduledStarts.get(task.taskId) ?? scenarioStartHour,
      endAbsoluteHourExclusive: scheduledEnds.get(task.taskId) ?? scenarioStartHour,
      durationHours: task.durationHours,
      cost: task.cost,
    }))
    .sort((a, b) => a.startAbsoluteHour - b.startAbsoluteHour || a.unitId.localeCompare(b.unitId));

  for (const segment of segments) {
    accumulateResearchCost(totals, spendingByHour, segment.startAbsoluteHour, segment.cost);
  }

  return {
    segments,
    spendingByAbsoluteHour: Array.from(spendingByHour.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([absoluteHour, cost]) => ({ absoluteHour, cost })),
    totals,
  };
}
