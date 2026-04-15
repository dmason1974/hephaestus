import type { BuildingsFile } from "../../schemas/building-schema.js";
import type { UnitCatalog } from "../../schemas/unit-schema.js";
import type { ScenarioFile } from "../../schemas/scenario-schema.js";
import { scenarioTruceLengthDays } from "../../schemas/scenario-schema.js";
import { toAbsoluteHour } from "../../core/time.js";
import { baselineHomelandMoraleOnDay } from "../economy/morale.js";
import { effectiveDurationFromMorale } from "../timing/activity-duration.js";
import { simulateUnitResearchTargets, type UnitResearchSimulationResult, type UnitResearchTargets } from "./unit-research-sim.js";

type QueueType = "air" | "naval" | "land" | "loadout";

export type MobilizationDemand = {
  unitId: string;
  count: number;
  researchTargetLevel?: number;
  minMobilizeLevel?: number;
  queueGroup?: string;
  forcedCityCount?: number;
  forcedRecruitingOfficeLevel?: number;
};

export type MobilizationTranche = {
  unitId: string;
  mobilizeLevel: number;
  count: number;
  queueType: QueueType;
  queueKey: string;
  requiredBaseLevel: number;
  requiredArmyBaseLevel: number;
  requiredRecruitingOfficeLevel: number;
  baseMobilizationHours: number;
};

export type MobilizationSegment = {
  queueType: QueueType;
  queueKey: string;
  cityIndex: number;
  unitId: string;
  mobilizeLevel: number;
  startAbsoluteHour: number;
  endAbsoluteHourExclusive: number;
  durationHours: number;
  moralePct: number;
  recruitingOfficeLevel: number;
};

export type MobilizationCityProfile = {
  queueType: QueueType;
  queueKey: string;
  cityCount: number;
  requiredBaseLevel: number;
  requiredArmyBaseLevel: number;
  requiredRecruitingOfficeLevel: number;
  perCityQueueHours: number[];
};

export type MobilizationPlanResult = {
  researchTargets: UnitResearchTargets;
  researchPlan: UnitResearchSimulationResult;
  tranches: MobilizationTranche[];
  segments: MobilizationSegment[];
  cityProfiles: MobilizationCityProfile[];
};

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
    throw new Error(`mobilization duration must be >= 0, got ${hours}`);
  }

  return Math.ceil(hours);
}

function mapDayForAbsoluteHour(absoluteHour: number) {
  return Math.floor(absoluteHour / 24) + 1;
}

function highestUnitLevel(catalog: UnitCatalog, unitId: string) {
  const unit = catalog.units[unitId];
  if (!unit) {
    throw new Error(`unknown unit "${unitId}"`);
  }

  return Math.max(...Object.keys(unit.levels).map(level => Number(level)));
}

function queueTypeForUnit(catalog: UnitCatalog, unitId: string): QueueType {
  const unit = catalog.units[unitId];
  if (!unit) {
    throw new Error(`unknown unit "${unitId}"`);
  }

  const category = unit.category.trim().toLowerCase();
  const firstLevel = unit.levels[String(Math.min(...Object.keys(unit.levels).map(level => Number(level))))];
  const hasRequirement = (id: string) => firstLevel?.requirements.some(requirement => {
    const parsed = parseLevelRequirement(requirement);
    return parsed?.id === id;
  }) ?? false;

  if (hasRequirement("naval_base") || category === "naval") return "naval";
  if (hasRequirement("air_base") || category === "air") return "air";
  if (hasRequirement("army_base") || category === "infantry" || category === "support") return "land";
  if (category === "loadout") return "loadout";

  throw new Error(`unsupported mobilisation category "${unit.category}" for ${unitId}`);
}

function parseLevelRequirement(requirement: string) {
  const match = requirement.trim().match(/^(.+?)\s+level\s+(\d+)$/i);
  if (!match) return null;

  return {
    id: match[1].trim(),
    level: Number(match[2]),
  };
}

function cumulativeUnitLimitForLevel(catalog: UnitCatalog, unitId: string, level: number) {
  const unit = catalog.units[unitId];
  if (!unit) {
    throw new Error(`unknown unit "${unitId}"`);
  }

  let lastDefined: number | undefined;
  for (let current = 1; current <= level; current++) {
    const unitLimit = unit.levels[String(current)]?.mobilisation.unit_limit;
    if (unitLimit !== undefined) {
      lastDefined = unitLimit;
    }
  }

  return lastDefined ?? Number.POSITIVE_INFINITY;
}

function mobilizationTranchesForDemand(
  catalog: UnitCatalog,
  demand: MobilizationDemand
): MobilizationTranche[] {
  const researchTargetLevel = demand.researchTargetLevel ?? highestUnitLevel(catalog, demand.unitId);
  const minMobilizeLevel = Math.max(1, Math.floor(demand.minMobilizeLevel ?? 1));
  if (!Number.isFinite(demand.count) || demand.count < 0) {
    throw new Error(`mobilization count for ${demand.unitId} must be >= 0, got ${demand.count}`);
  }
  if (demand.count === 0) return [];
  if (minMobilizeLevel > researchTargetLevel) {
    throw new Error(
      `mobilization level floor ${minMobilizeLevel} for ${demand.unitId} exceeds research target ${researchTargetLevel}`
    );
  }

  const unit = catalog.units[demand.unitId];
  if (!unit) {
    throw new Error(`unknown unit "${demand.unitId}"`);
  }
  const queueType = queueTypeForUnit(catalog, demand.unitId);
  const queueKey = `${queueType}:${demand.queueGroup ?? demand.unitId}`;

  let remaining = Math.floor(demand.count);
  let previousCap = 0;
  const tranches: MobilizationTranche[] = [];

  for (let level = minMobilizeLevel; level <= researchTargetLevel; level++) {
    if (remaining <= 0) break;

    const levelData = unit.levels[String(level)];
    if (!levelData) {
      throw new Error(`missing unit level ${level} for ${demand.unitId}`);
    }

    const cumulativeLimit = cumulativeUnitLimitForLevel(catalog, demand.unitId, level);
    const trancheCapacity = Number.isFinite(cumulativeLimit)
      ? Math.max(0, cumulativeLimit - previousCap)
      : remaining;
    const trancheCount = Math.min(remaining, trancheCapacity);
    previousCap = Number.isFinite(cumulativeLimit) ? cumulativeLimit : previousCap;
    if (trancheCount <= 0) continue;

    let requiredBaseLevel = 0;
    let requiredArmyBaseLevel = 0;
    let requiredRecruitingOfficeLevel = 0;
    for (const requirement of levelData.requirements) {
      const parsed = parseLevelRequirement(requirement);
      if (!parsed) continue;

      if (parsed.id === "air_base" || parsed.id === "naval_base") {
        requiredBaseLevel = Math.max(requiredBaseLevel, parsed.level);
      }
      if (parsed.id === "army_base") {
        requiredArmyBaseLevel = Math.max(requiredArmyBaseLevel, parsed.level);
      }
      if (parsed.id === "recruiting_office") {
        requiredRecruitingOfficeLevel = Math.max(requiredRecruitingOfficeLevel, parsed.level);
      }
    }

    tranches.push({
      unitId: demand.unitId,
      mobilizeLevel: level,
      count: trancheCount,
      queueType,
      queueKey,
      requiredBaseLevel,
      requiredArmyBaseLevel,
      requiredRecruitingOfficeLevel,
      baseMobilizationHours: durationHours(levelData.mobilisation.time),
    });
    remaining -= trancheCount;
  }

  if (remaining > 0) {
    throw new Error(
      `requested ${demand.count} ${demand.unitId} but researched levels only allow ${demand.count - remaining}`
    );
  }

  return tranches;
}

function mobilizationSpeedBonusPct(buildings: BuildingsFile, recruitingOfficeLevel: number) {
  if (recruitingOfficeLevel <= 0) return 0;

  const levelData =
    buildings.buildings.recruiting_office?.levels[
      String(recruitingOfficeLevel) as keyof typeof buildings.buildings.recruiting_office.levels
    ];

  return levelData?.mobilisation_speed_bonus_pct ?? 0;
}

function effectiveMobilizationHours(
  buildings: BuildingsFile,
  recruitingOfficeLevel: number,
  baseMobilizationHours: number,
  startAbsoluteHour: number
) {
  const startDay = Math.max(1, mapDayForAbsoluteHour(startAbsoluteHour));
  const moralePct = baselineHomelandMoraleOnDay(startDay);
  const moraleAdjustedHours = effectiveDurationFromMorale(baseMobilizationHours, moralePct);
  const bonusPct = mobilizationSpeedBonusPct(buildings, recruitingOfficeLevel);
  return normalizeDurationHours(moraleAdjustedHours / (1 + bonusPct));
}

type ScheduledJob = {
  queueType: QueueType;
  queueKey: string;
  unitId: string;
  mobilizeLevel: number;
  cityIndex: number;
  startAbsoluteHour: number;
  endAbsoluteHourExclusive: number;
  durationHours: number;
  moralePct: number;
  recruitingOfficeLevel: number;
};

function scheduleBackwardOnCities(args: {
  buildings: BuildingsFile;
  deadlineAbsoluteHour: number;
  cityCount: number;
  queueType: QueueType;
  queueKey: string;
  recruitingOfficeLevel: number;
  jobs: Array<{ unitId: string; mobilizeLevel: number; baseMobilizationHours: number }>;
}) {
  const cityFreeBefore = Array.from({ length: args.cityCount }, () => args.deadlineAbsoluteHour);
  const scheduled: ScheduledJob[] = [];

  for (const job of args.jobs) {
    let selectedCity = 0;
    for (let city = 1; city < cityFreeBefore.length; city++) {
      if (cityFreeBefore[city] > cityFreeBefore[selectedCity]) {
        selectedCity = city;
      }
    }

    const endAbsoluteHourExclusive = cityFreeBefore[selectedCity];
    let startAbsoluteHour = endAbsoluteHourExclusive - normalizeDurationHours(job.baseMobilizationHours);
    let durationHours = 0;
    let previousStartAbsoluteHour = Number.NaN;

    // Mobilisation duration depends on morale at the map day when the queue item starts.
    while (startAbsoluteHour !== previousStartAbsoluteHour) {
      previousStartAbsoluteHour = startAbsoluteHour;
      durationHours = effectiveMobilizationHours(
        args.buildings,
        args.recruitingOfficeLevel,
        job.baseMobilizationHours,
        startAbsoluteHour
      );
      startAbsoluteHour = endAbsoluteHourExclusive - durationHours;
    }

    const moralePct = baselineHomelandMoraleOnDay(Math.max(1, mapDayForAbsoluteHour(startAbsoluteHour)));
    scheduled.push({
      queueType: args.queueType,
      queueKey: args.queueKey,
      unitId: job.unitId,
      mobilizeLevel: job.mobilizeLevel,
      cityIndex: selectedCity + 1,
      startAbsoluteHour,
      endAbsoluteHourExclusive,
      durationHours,
      moralePct,
      recruitingOfficeLevel: args.recruitingOfficeLevel,
    });
    cityFreeBefore[selectedCity] = startAbsoluteHour;
  }

  return {
    scheduled,
    cityQueueHours: cityFreeBefore.map(startHour => args.deadlineAbsoluteHour - startHour),
  };
}

function buildResearchDeadlineMap(
  scheduledJobs: ScheduledJob[]
) {
  const deadlines: Record<string, number> = {};

  for (const job of scheduledJobs) {
    const key = `${job.unitId}:${job.mobilizeLevel}`;
    deadlines[key] =
      deadlines[key] === undefined
        ? job.startAbsoluteHour
        : Math.min(deadlines[key], job.startAbsoluteHour);
  }

  return deadlines;
}

function maxRequiredLevels(tranches: MobilizationTranche[], queueKey: string) {
  return tranches
    .filter(tranche => tranche.queueKey === queueKey)
    .reduce(
      (acc, tranche) => ({
        base: Math.max(acc.base, tranche.requiredBaseLevel),
        armyBase: Math.max(acc.armyBase, tranche.requiredArmyBaseLevel),
        recruitingOffice: Math.max(acc.recruitingOffice, tranche.requiredRecruitingOfficeLevel),
      }),
      { base: 0, armyBase: 0, recruitingOffice: 0 }
    );
}

function demandForQueueKey(
  catalog: UnitCatalog,
  demands: MobilizationDemand[],
  queueKey: string
) {
  return demands.find(demand => {
    const queueType = queueTypeForUnit(catalog, demand.unitId);
    return `${queueType}:${demand.queueGroup ?? demand.unitId}` === queueKey;
  });
}

export function planMobilizationBuild(args: {
  catalog: UnitCatalog;
  buildings: BuildingsFile;
  scenario: ScenarioFile;
  demands: MobilizationDemand[];
}) : MobilizationPlanResult {
  const truceLengthDays = scenarioTruceLengthDays(args.scenario);
  if (truceLengthDays === undefined) {
    throw new Error(`scenario ${args.scenario.id} is missing truce_length_days`);
  }

  const deadlineAbsoluteHour = toAbsoluteHour(args.scenario.start.day, args.scenario.start.hour) + (truceLengthDays * 24);
  const tranches = args.demands.flatMap(demand => mobilizationTranchesForDemand(args.catalog, demand));
  const researchTargets = Object.fromEntries(
    args.demands.map(demand => [
      demand.unitId,
      demand.researchTargetLevel ?? highestUnitLevel(args.catalog, demand.unitId),
    ])
  );

  const queueGroupConfigs = Array.from(
    new Map(
      tranches.map(tranche => [tranche.queueKey, {
        queueKey: tranche.queueKey,
        queueType: tranche.queueType,
        requirements: {
          ...maxRequiredLevels(tranches, tranche.queueKey),
          recruitingOffice: Math.max(
            maxRequiredLevels(tranches, tranche.queueKey).recruitingOffice,
            demandForQueueKey(args.catalog, args.demands, tranche.queueKey)?.forcedRecruitingOfficeLevel ?? 0
          ),
        },
        jobs: tranches
          .filter(candidate => candidate.queueKey === tranche.queueKey)
          .flatMap(candidate =>
            Array.from({ length: candidate.count }, () => ({
              unitId: candidate.unitId,
              mobilizeLevel: candidate.mobilizeLevel,
              baseMobilizationHours: candidate.baseMobilizationHours,
            }))
          )
          .sort((a, b) => b.mobilizeLevel - a.mobilizeLevel || b.baseMobilizationHours - a.baseMobilizationHours),
        forcedCityCount: demandForQueueKey(args.catalog, args.demands, tranche.queueKey)?.forcedCityCount,
      }])
    ).values()
  );

  const tryScheduleGroups = (
    groupIndex: number,
    scheduledGroups: ScheduledJob[],
    profiles: MobilizationCityProfile[]
  ): MobilizationPlanResult | null => {
    if (groupIndex >= queueGroupConfigs.length) {
      const researchDeadlines = buildResearchDeadlineMap(scheduledGroups);

      try {
        const researchPlan = simulateUnitResearchTargets(
          args.catalog,
          researchTargets,
          args.scenario,
          {
            latestCompletionByUnitLevel: researchDeadlines,
            unitDemandCounts: Object.fromEntries(
              args.demands.map(demand => [demand.unitId, demand.count])
            ),
          }
        );

        return {
          researchTargets,
          researchPlan,
          tranches,
          segments: scheduledGroups
            .sort((a, b) => a.startAbsoluteHour - b.startAbsoluteHour || a.unitId.localeCompare(b.unitId))
            .map(job => ({
              queueType: job.queueType,
              queueKey: job.queueKey,
              cityIndex: job.cityIndex,
              unitId: job.unitId,
              mobilizeLevel: job.mobilizeLevel,
              startAbsoluteHour: job.startAbsoluteHour,
              endAbsoluteHourExclusive: job.endAbsoluteHourExclusive,
              durationHours: job.durationHours,
              moralePct: job.moralePct,
              recruitingOfficeLevel: job.recruitingOfficeLevel,
            })),
          cityProfiles: profiles,
        };
      } catch {
        return null;
      }
    }

    const group = queueGroupConfigs[groupIndex];
    if (!group || group.jobs.length === 0) {
      return tryScheduleGroups(groupIndex + 1, scheduledGroups, profiles);
    }

    const minCities = Math.max(1, group.forcedCityCount ?? 1);
    const maxCities = group.forcedCityCount ?? Math.max(1, group.jobs.length);

    for (let cityCount = minCities; cityCount <= maxCities; cityCount++) {
      const schedule = scheduleBackwardOnCities({
        buildings: args.buildings,
        deadlineAbsoluteHour,
        cityCount,
        queueType: group.queueType,
        queueKey: group.queueKey,
        recruitingOfficeLevel: group.requirements.recruitingOffice,
        jobs: group.jobs,
      });

      const result = tryScheduleGroups(
        groupIndex + 1,
        [...scheduledGroups, ...schedule.scheduled],
        [
          ...profiles,
          {
            queueType: group.queueType,
            queueKey: group.queueKey,
            cityCount,
            requiredBaseLevel: group.requirements.base,
            requiredArmyBaseLevel: group.requirements.armyBase,
            requiredRecruitingOfficeLevel: group.requirements.recruitingOffice,
            perCityQueueHours: schedule.cityQueueHours,
          },
        ]
      );

      if (result) return result;
    }

    return null;
  };

  const scheduled = tryScheduleGroups(0, [], []);
  if (scheduled) {
    return scheduled;
  }

  throw new Error("unable to fit requested research and mobilization package before truce end");
}
