import type { BuildingsFile } from "../../validation/buildingSchema.js";
import { type Resource as EconomyResource } from "../../core/constants.js";
import {
  dayStartAbsoluteHour,
  scenarioStartAbsoluteHour,
  type ScenarioStartLike,
} from "../../core/time.js";
import { bunkerMoraleBonusN } from "../../models/morale/bunker.js";
import { homelandMoraleOnDayWithBunkers } from "../../models/morale/morale-baseline.js";
import { moraleProductionMultiplier } from "../../models/morale/morale-modifier.js";

export type Resource = EconomyResource;

export type CityState = {
  cityId: string;
  baseHourlyProduction: Record<Resource, number>;
  buildings: { arms_industry: number; underground_bunkers: number };
};

export type BuildAction = {
  cityId: string;
  buildingId: "arms_industry" | "underground_bunkers";
  targetLevel: number;
  startRelHour?: number;
  startHour?: number;
};

export type HourlyCityResult = {
  hour: number;
  cityId: string;
  effectiveBonusPct: number;
  multiplier: number;
  flatCash: number;
  production: Record<Resource, number>;
};

export type SimulationResult = {
  hoursSimulated: number;
  perHourPerCity: HourlyCityResult[];
  perHourAggregate: Array<{ hour: number; production: Record<Resource, number> }>;
  debug?: Array<{
    hour: number;
    cityId: string;
    currentFromLevel: number;
    currentToLevel: number;
    progressRatio: number;
    segmentStartMinute: number | null;
    segmentEndMinute: number | null;
    flatCashActiveLevel: number;
    bunkerLevelAtDayStart: number;
    bunkerMoraleBonusN: number;
    absoluteHour: number;
    dayIndex: number;
    dayStartAbsoluteHour: number;
  }>;
  timingDebug?: {
    scenarioStartDay: number;
    scenarioStartHour: number;
    scenarioStartAbsoluteHour: number;
    builds: Array<{
      cityId: string;
      buildingId: "arms_industry" | "underground_bunkers";
      fromLevel: number;
      toLevel: number;
      startRelHour: number;
      durationHours: number;
      completionAbs: number;
      activationDay: number;
    }>;
    days: Array<{
      cityId: string;
      dayIndex: number;
      dayStartAbs: number;
      bunkerLevelAtDayStart: number;
    }>;
  };
};

type ArmsIndustryLevelData = {
  level: number;
  productionBonusPct: number;
  flatCash: number;
  buildTimeMinutes: number;
};

type UndergroundBunkerLevelData = {
  level: number;
  buildTimeMinutes: number;
};

type BuildSegment = {
  cityId: string;
  buildingId: "arms_industry" | "underground_bunkers";
  fromLevel: number;
  toLevel: number;
  startMinute: number;
  endMinute: number;
  startRelHour: number;
};

const RESOURCE_KEYS: Resource[] = [
  "supplies",
  "components",
  "fuel",
  "rares",
  "electronics",
  "cash",
  "manpower",
];

function zeroProduction(): Record<Resource, number> {
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

function cloneProduction(source: Record<Resource, number>): Record<Resource, number> {
  return {
    supplies: source.supplies,
    components: source.components,
    fuel: source.fuel,
    rares: source.rares,
    electronics: source.electronics,
    cash: source.cash,
    manpower: source.manpower,
  };
}

function lerp(a: number, b: number, t: number) {
  return a + ((b - a) * t);
}

function buildTimeToMinutes(buildTime: {
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
}) {
  const days = buildTime.days ?? 0;
  const hours = buildTime.hours ?? 0;
  const minutes = buildTime.minutes ?? 0;
  const seconds = buildTime.seconds ?? 0;
  return (days * 24 * 60) + (hours * 60) + minutes + (seconds / 60);
}

function getArmsIndustryLevels(buildings: BuildingsFile): Record<number, ArmsIndustryLevelData> {
  const building = buildings.buildings.arms_industry;
  if (!building) {
    throw new Error('buildings file is missing "arms_industry"');
  }

  const levels: Record<number, ArmsIndustryLevelData> = {
    0: {
      level: 0,
      productionBonusPct: 0,
      flatCash: 0,
      buildTimeMinutes: 0,
    },
  };

  for (const [levelKey, levelData] of Object.entries(building.levels)) {
    if (!levelData) continue;
    const level = Number(levelKey);
    levels[level] = {
      level,
      productionBonusPct: levelData.production_bonus_pct ?? 0,
      flatCash: levelData.flat_bonus?.cash ?? 0,
      buildTimeMinutes: buildTimeToMinutes(levelData.build_time),
    };
  }

  return levels;
}

function getUndergroundBunkerLevels(
  buildings: BuildingsFile
): Record<number, UndergroundBunkerLevelData> {
  const building = buildings.buildings.underground_bunkers;
  if (!building) {
    throw new Error('buildings file is missing "underground_bunkers"');
  }

  const levels: Record<number, UndergroundBunkerLevelData> = {
    0: {
      level: 0,
      buildTimeMinutes: 0,
    },
  };

  for (const [levelKey, levelData] of Object.entries(building.levels)) {
    if (!levelData) continue;
    const level = Number(levelKey);
    levels[level] = {
      level,
      buildTimeMinutes: buildTimeToMinutes(levelData.build_time),
    };
  }

  return levels;
}

function scheduleBuildSegments(
  cities: CityState[],
  buildOrder: BuildAction[],
  armsIndustryLevels: Record<number, ArmsIndustryLevelData>,
  undergroundBunkerLevels: Record<number, UndergroundBunkerLevelData>,
  scenario: ScenarioStartLike
) {
  const scenarioStartMinute = scenarioStartAbsoluteHour(scenario) * 60;
  const cityLevels = new Map<string, { arms_industry: number; underground_bunkers: number }>();
  const cityAvailableMinute = new Map<string, number>();
  const segmentsByCity = new Map<
    string,
    { arms_industry: BuildSegment[]; underground_bunkers: BuildSegment[] }
  >();

  for (const city of cities) {
    cityLevels.set(city.cityId, { ...city.buildings });
    cityAvailableMinute.set(city.cityId, scenarioStartMinute);
    segmentsByCity.set(city.cityId, { arms_industry: [], underground_bunkers: [] });
  }

  for (const action of buildOrder) {
    const currentLevels = cityLevels.get(action.cityId);
    if (currentLevels === undefined) {
      throw new Error(`unknown cityId "${action.cityId}" in build order`);
    }

    const currentLevel = currentLevels[action.buildingId];

    if (action.targetLevel <= currentLevel) continue;
    if (action.targetLevel < 0 || action.targetLevel > 5) {
      throw new Error(`targetLevel must be between 0 and 5, got ${action.targetLevel}`);
    }

    let nextStartMinute = Math.max(
      scenarioStartMinute + ((action.startRelHour ?? action.startHour ?? 0) * 60),
      cityAvailableMinute.get(action.cityId) ?? 0
    );

    for (let level = currentLevel + 1; level <= action.targetLevel; level++) {
      const levelInfo =
        action.buildingId === "arms_industry"
          ? armsIndustryLevels[level]
          : undergroundBunkerLevels[level];
      if (!levelInfo) {
        throw new Error(`missing ${action.buildingId} level ${level} in buildings data`);
      }

      const segment: BuildSegment = {
        cityId: action.cityId,
        buildingId: action.buildingId,
        fromLevel: level - 1,
        toLevel: level,
        startMinute: nextStartMinute,
        endMinute: nextStartMinute + levelInfo.buildTimeMinutes,
        startRelHour: (nextStartMinute - scenarioStartMinute) / 60,
      };

      segmentsByCity.get(action.cityId)?.[action.buildingId].push(segment);
      nextStartMinute = segment.endMinute;
    }

    cityLevels.set(action.cityId, {
      ...currentLevels,
      [action.buildingId]: action.targetLevel,
    });
    cityAvailableMinute.set(action.cityId, nextStartMinute);
  }

  return segmentsByCity;
}

function getBunkerLevelAtDayStart(args: {
  dayIndex: number;
  startingLevel: number;
  segments: BuildSegment[];
  scenario: ScenarioStartLike;
}) {
  const dayStartHourAbs = dayStartAbsoluteHour(args.scenario, args.dayIndex);
  let completedLevel = args.startingLevel;

  for (const segment of args.segments) {
    const completionHour = segment.endMinute / 60;
    if (completionHour < dayStartHourAbs) {
      completedLevel = segment.toLevel;
      continue;
    }
    break;
  }

  return completedLevel;
}

function getCityStateAtHourEnd(args: {
  cityId: string;
  hour: number;
  segments: BuildSegment[];
  levelData: Record<number, ArmsIndustryLevelData>;
  scenario: ScenarioStartLike;
}) {
  const endMinute = (scenarioStartAbsoluteHour(args.scenario) + args.hour + 1) * 60;
  let effectiveBonusPct = 0;
  let flatCash = 0;
  let currentFromLevel = 0;
  let currentToLevel = 0;
  let progressRatio = 1;
  let segmentStartMinute: number | null = null;
  let segmentEndMinute: number | null = null;
  let flatCashActiveLevel = 0;

  for (const segment of args.segments) {
    const fromData = args.levelData[segment.fromLevel];
    const toData = args.levelData[segment.toLevel];

    if (endMinute < segment.startMinute) {
      break;
    }

    if (endMinute < segment.endMinute) {
      const duration = segment.endMinute - segment.startMinute;
      const ratio = duration <= 0 ? 1 : (endMinute - segment.startMinute) / duration;
      effectiveBonusPct = lerp(fromData.productionBonusPct, toData.productionBonusPct, ratio);
      flatCash = fromData.flatCash;
      currentFromLevel = segment.fromLevel;
      currentToLevel = segment.toLevel;
      progressRatio = ratio;
      segmentStartMinute = segment.startMinute;
      segmentEndMinute = segment.endMinute;
      flatCashActiveLevel = segment.fromLevel;
      return {
        effectiveBonusPct,
        flatCash,
        currentFromLevel,
        currentToLevel,
        progressRatio,
        segmentStartMinute,
        segmentEndMinute,
        flatCashActiveLevel,
      };
    }

    effectiveBonusPct = toData.productionBonusPct;
    currentFromLevel = segment.toLevel;
    currentToLevel = segment.toLevel;
    progressRatio = 1;
    segmentStartMinute = segment.startMinute;
    segmentEndMinute = segment.endMinute;

    if (args.hour >= Math.ceil(segment.endMinute / 60)) {
      flatCash = toData.flatCash;
      flatCashActiveLevel = segment.toLevel;
    }
  }

  return {
    effectiveBonusPct,
    flatCash,
    currentFromLevel,
    currentToLevel,
    progressRatio,
    segmentStartMinute,
    segmentEndMinute,
    flatCashActiveLevel,
  };
}

export function simulateBuildOrder(args: {
  cities: CityState[];
  buildOrder: BuildAction[];
  buildings: BuildingsFile;
  scenario: ScenarioStartLike;
  hoursToSimulate: number;
}): SimulationResult {
  if (!Number.isFinite(args.hoursToSimulate) || args.hoursToSimulate < 0) {
    throw new Error(`hoursToSimulate must be >= 0, got ${args.hoursToSimulate}`);
  }

  const armsIndustryLevels = getArmsIndustryLevels(args.buildings);
  const undergroundBunkerLevels = getUndergroundBunkerLevels(args.buildings);
  const segmentsByCity = scheduleBuildSegments(
    args.cities,
    args.buildOrder,
    armsIndustryLevels,
    undergroundBunkerLevels,
    args.scenario
  );
  const perHourPerCity: HourlyCityResult[] = [];
  const debug: SimulationResult["debug"] = [];
  const timingDays: SimulationResult["timingDebug"]["days"] = [];

  for (let hour = 0; hour < args.hoursToSimulate; hour++) {
    for (const city of args.cities) {
      const absoluteHour = scenarioStartAbsoluteHour(args.scenario) + hour;
      const dayIndex = Math.floor(hour / 24) + 1;
      const dayStartAbs = dayStartAbsoluteHour(args.scenario, dayIndex);
      const citySegments = segmentsByCity.get(city.cityId) ?? {
        arms_industry: [],
        underground_bunkers: [],
      };
      const state = getCityStateAtHourEnd({
        cityId: city.cityId,
        hour,
        segments: citySegments.arms_industry,
        levelData: armsIndustryLevels,
        scenario: args.scenario,
      });
      const bunkerLevelAtDayStart = getBunkerLevelAtDayStart({
        dayIndex,
        startingLevel: city.buildings.underground_bunkers,
        segments: citySegments.underground_bunkers,
        scenario: args.scenario,
      });
      const morale = homelandMoraleOnDayWithBunkers(dayIndex, bunkerLevelAtDayStart);
      const moraleMultiplier = moraleProductionMultiplier(morale);
      const multiplier = moraleMultiplier * (1 + state.effectiveBonusPct);
      const production = zeroProduction();

      for (const resource of RESOURCE_KEYS) {
        production[resource] = city.baseHourlyProduction[resource] * multiplier;
      }
      production.cash += state.flatCash;

      perHourPerCity.push({
        hour,
        cityId: city.cityId,
        effectiveBonusPct: state.effectiveBonusPct,
        multiplier,
        flatCash: state.flatCash,
        production,
      });

      debug.push({
        hour,
        cityId: city.cityId,
        currentFromLevel: state.currentFromLevel,
        currentToLevel: state.currentToLevel,
        progressRatio: state.progressRatio,
        segmentStartMinute: state.segmentStartMinute,
        segmentEndMinute: state.segmentEndMinute,
        flatCashActiveLevel: state.flatCashActiveLevel,
        bunkerLevelAtDayStart,
        bunkerMoraleBonusN: bunkerMoraleBonusN(bunkerLevelAtDayStart),
        absoluteHour,
        dayIndex,
        dayStartAbsoluteHour: dayStartAbs,
      });

      if (!timingDays.some(entry => entry.cityId === city.cityId && entry.dayIndex === dayIndex)) {
        timingDays.push({
          cityId: city.cityId,
          dayIndex,
          dayStartAbs,
          bunkerLevelAtDayStart,
        });
      }
    }
  }

  const perHourAggregate = Array.from({ length: args.hoursToSimulate }, (_, hour) => {
    const production = zeroProduction();
    for (const cityResult of perHourPerCity) {
      if (cityResult.hour !== hour) continue;
      for (const resource of RESOURCE_KEYS) {
        production[resource] += cityResult.production[resource];
      }
    }
    return { hour, production };
  });

  return {
    hoursSimulated: args.hoursToSimulate,
    perHourPerCity,
    perHourAggregate,
    debug,
    timingDebug: {
      scenarioStartDay: args.scenario.start.day,
      scenarioStartHour: args.scenario.start.hour,
      scenarioStartAbsoluteHour: scenarioStartAbsoluteHour(args.scenario),
      builds: Array.from(segmentsByCity.values())
        .flatMap(citySegments => [...citySegments.arms_industry, ...citySegments.underground_bunkers])
        .map(segment => ({
          cityId: segment.cityId,
          buildingId: segment.buildingId,
          fromLevel: segment.fromLevel,
          toLevel: segment.toLevel,
          startRelHour: segment.startRelHour,
          durationHours: (segment.endMinute - segment.startMinute) / 60,
          completionAbs: segment.endMinute / 60,
          activationDay:
            Math.floor(
              ((segment.endMinute / 60) - scenarioStartAbsoluteHour(args.scenario)) / 24
            ) + 2,
        })),
      days: timingDays,
    },
  };
}
