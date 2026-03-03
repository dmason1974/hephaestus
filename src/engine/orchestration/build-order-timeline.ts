import { scenarioStartAbsoluteHour, type ScenarioStartLike } from "../../core/time.js";
import type { BuildingsFile } from "../../schemas/building-schema.js";

export type BuildingId = "arms_industry" | "underground_bunkers";

export type BuildingLevels = {
  arms_industry: number;
  underground_bunkers: number;
};

export type TimelineCityState = {
  cityId: string;
  buildings: BuildingLevels;
};

export type BuildAction = {
  cityId: string;
  buildingId: BuildingId;
  targetLevel: number;
  startRelHour?: number;
  startHour?: number;
};

export type BuildSegment = {
  cityId: string;
  buildingId: BuildingId;
  fromLevel: number;
  toLevel: number;
  startMinute: number;
  endMinute: number;
  startRelHour: number;
};

export type BuildSegmentsByCity = Map<
  string,
  { arms_industry: BuildSegment[]; underground_bunkers: BuildSegment[] }
>;

export type BuildingLevelTimingData = {
  level: number;
  buildTimeMinutes: number;
};

export type BuildingStateAtHourEnd = {
  currentFromLevel: number;
  currentToLevel: number;
  progressRatio: number;
  segmentStartMinute: number | null;
  segmentEndMinute: number | null;
  flatCashActiveLevel: number;
};

export function buildTimeToMinutes(buildTime: {
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

export function getBuildingLevelTimings(
  buildings: BuildingsFile,
  buildingId: BuildingId
): Record<number, BuildingLevelTimingData> {
  const building = buildings.buildings[buildingId];
  if (!building) {
    throw new Error(`buildings file is missing "${buildingId}"`);
  }

  const levels: Record<number, BuildingLevelTimingData> = {
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

export function scheduleBuildSegments(args: {
  cities: TimelineCityState[];
  buildOrder: BuildAction[];
  buildings: BuildingsFile;
  scenario: ScenarioStartLike;
}): BuildSegmentsByCity {
  const levelTimings = {
    arms_industry: getBuildingLevelTimings(args.buildings, "arms_industry"),
    underground_bunkers: getBuildingLevelTimings(args.buildings, "underground_bunkers"),
  };
  const scenarioStartMinute = scenarioStartAbsoluteHour(args.scenario) * 60;
  const cityLevels = new Map<string, BuildingLevels>();
  const cityAvailableMinute = new Map<string, number>();
  const segmentsByCity: BuildSegmentsByCity = new Map();

  for (const city of args.cities) {
    cityLevels.set(city.cityId, { ...city.buildings });
    cityAvailableMinute.set(city.cityId, scenarioStartMinute);
    segmentsByCity.set(city.cityId, { arms_industry: [], underground_bunkers: [] });
  }

  for (const action of args.buildOrder) {
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
      const levelInfo = levelTimings[action.buildingId][level];
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

export function getCompletedBuildingLevelAtDayStart(args: {
  mapDay: number;
  startingLevel: number;
  segments: BuildSegment[];
}) {
  const dayStartHourAbs = (args.mapDay - 1) * 24;
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

export function getBuildingStateAtHourEnd(args: {
  hour: number;
  segments: BuildSegment[];
  scenario: ScenarioStartLike;
}): BuildingStateAtHourEnd {
  const endMinute = (scenarioStartAbsoluteHour(args.scenario) + args.hour + 1) * 60;
  let currentFromLevel = 0;
  let currentToLevel = 0;
  let progressRatio = 1;
  let segmentStartMinute: number | null = null;
  let segmentEndMinute: number | null = null;
  let flatCashActiveLevel = 0;

  for (const segment of args.segments) {
    if (endMinute < segment.startMinute) break;

    if (endMinute < segment.endMinute) {
      const duration = segment.endMinute - segment.startMinute;
      const ratio = duration <= 0 ? 1 : (endMinute - segment.startMinute) / duration;
      currentFromLevel = segment.fromLevel;
      currentToLevel = segment.toLevel;
      progressRatio = ratio;
      segmentStartMinute = segment.startMinute;
      segmentEndMinute = segment.endMinute;
      flatCashActiveLevel = segment.fromLevel;
      return {
        currentFromLevel,
        currentToLevel,
        progressRatio,
        segmentStartMinute,
        segmentEndMinute,
        flatCashActiveLevel,
      };
    }

    currentFromLevel = segment.toLevel;
    currentToLevel = segment.toLevel;
    progressRatio = 1;
    segmentStartMinute = segment.startMinute;
    segmentEndMinute = segment.endMinute;

    if (args.hour >= Math.ceil(segment.endMinute / 60)) {
      flatCashActiveLevel = segment.toLevel;
    }
  }

  return {
    currentFromLevel,
    currentToLevel,
    progressRatio,
    segmentStartMinute,
    segmentEndMinute,
    flatCashActiveLevel,
  };
}
