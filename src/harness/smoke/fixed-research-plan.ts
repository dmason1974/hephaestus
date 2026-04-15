import { toAbsoluteHour } from "../../core/time.js";
import type { Resource } from "../../core/constants.js";
import type { UnitCatalog } from "../../schemas/unit-schema.js";
import type { ScenarioFile } from "../../schemas/scenario-schema.js";
import { scenarioResearchUnlockedThroughDayAtStart, scenarioTruceLengthDays } from "../../schemas/scenario-schema.js";
import type { UnitResearchAction, UnitResearchSegment, UnitResearchSimulationResult } from "../../engine/simulation/unit-research-sim.js";

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
  return Math.ceil(hours);
}

function researchUnlockAbsoluteHour(scenario: ScenarioFile, unlockDay: number) {
  const scenarioStartHour = toAbsoluteHour(scenario.start.day, scenario.start.hour);
  const unlockedThroughDayAtStart = scenarioResearchUnlockedThroughDayAtStart(scenario);
  const effectiveUnlockDay = Math.max(1, unlockDay - unlockedThroughDayAtStart + 1);

  if (effectiveUnlockDay <= scenario.start.day) {
    return scenarioStartHour;
  }

  return toAbsoluteHour(effectiveUnlockDay, 0);
}

function researchDeadlineAbsoluteHour(scenario: ScenarioFile) {
  const truceLengthDays = scenarioTruceLengthDays(scenario);
  if (truceLengthDays === undefined) {
    throw new Error(`scenario ${scenario.id} is missing truce_length_days`);
  }
  return toAbsoluteHour(scenario.start.day, scenario.start.hour) + (truceLengthDays * 24);
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

export function buildFixedResearchPlan(args: {
  catalog: UnitCatalog;
  scenario: ScenarioFile;
  lanes: UnitResearchAction[][];
  latestEndByAction?: Record<string, number>;
}): UnitResearchSimulationResult {
  const deadlineAbsoluteHour = researchDeadlineAbsoluteHour(args.scenario);
  const totals = zeroResources();
  const spendingByHour = new Map<number, Record<Resource, number>>();
  const segments: UnitResearchSegment[] = [];

  args.lanes.forEach((lane, laneIndex) => {
    let freeBefore = deadlineAbsoluteHour;

    for (let index = lane.length - 1; index >= 0; index--) {
      const action = lane[index];
      if (!action) continue;

      const unit = args.catalog.units[action.unitId];
      const levelData = unit?.levels[String(action.targetLevel)];
      if (!unit || !levelData) {
        throw new Error(`missing research data for ${action.unitId} level ${action.targetLevel}`);
      }

      const releaseHour = researchUnlockAbsoluteHour(args.scenario, levelData.research.unlock_day);
      const duration = normalizeDurationHours(durationHours(levelData.research.time));
      const actionKey = `${action.unitId}@${action.targetLevel}`;
      const actionLatestEnd = args.latestEndByAction?.[actionKey];
      const endAbsoluteHourExclusive = actionLatestEnd === undefined
        ? freeBefore
        : Math.min(freeBefore, actionLatestEnd);
      const startAbsoluteHour = endAbsoluteHourExclusive - duration;
      if (startAbsoluteHour < releaseHour) {
        throw new Error(`fixed research lane cannot fit ${action.unitId} level ${action.targetLevel} before truce end`);
      }

      segments.push({
        unitId: action.unitId,
        level: action.targetLevel,
        slot: laneIndex + 1,
        unlockDay: levelData.research.unlock_day,
        startAbsoluteHour,
        endAbsoluteHourExclusive,
        durationHours: duration,
        cost: { ...levelData.research.cost },
      });

      accumulateResearchCost(totals, spendingByHour, startAbsoluteHour, levelData.research.cost);
      freeBefore = startAbsoluteHour;
    }
  });

  return {
    segments: segments.sort((a, b) => a.startAbsoluteHour - b.startAbsoluteHour || a.unitId.localeCompare(b.unitId)),
    spendingByAbsoluteHour: Array.from(spendingByHour.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([absoluteHour, cost]) => ({ absoluteHour, cost })),
    totals,
  };
}
