import type { BuildingsFile } from "../../validation/buildingSchema.js";
import {
  DEFAULT_MORALE_DECAY_D,
  HOMELAND_TARGET_MORALE,
  STARTING_MORALE_DAY1,
  type GameSpeed,
  type Resource as EconomyResource,
  type StartingPopulation,
} from "../../core/constants.js";
import { scenarioStartAbsoluteHour, type ScenarioStartLike } from "../../core/time.js";
import {
  getEconomicBuildingEffectsForLevels,
  interpolateArmsIndustryEffects,
} from "../../models/economy/building-modifiers.js";
import {
  hourlyResourcePointAtAbsoluteHour,
  type CityResourceInputs,
} from "../../models/economy/city-production.js";
import {
  moraleOnDay,
  moraleProductionMultiplier,
  type MoraleParams,
} from "../../models/economy/morale.js";
import {
  getBuildingStateAtHourEnd,
  getCompletedBuildingLevelAtDayStart,
  scheduleBuildSegments,
  type BuildAction,
  type BuildingLevels,
} from "../../models/orchestration/build-order-timeline.js";

export type Resource = EconomyResource;
type ProducedResource = Exclude<Resource, "cash" | "manpower">;

export type CityState = {
  cityId: string;
  resource: ProducedResource;
  startPop: StartingPopulation;
  buildings: BuildingLevels;
  moraleParams?: MoraleParams;
  ecoInfraMultiplier?: CityResourceInputs["ecoInfraMultiplier"];
  hiddenMultiplierOverride?: CityResourceInputs["hiddenMultiplierOverride"];
  populationMode?: CityResourceInputs["populationMode"];
  populationOpts?: CityResourceInputs["populationOpts"];
  multiplierByPop?: CityResourceInputs["multiplierByPop"];
};
export type { BuildAction } from "../../models/orchestration/build-order-timeline.js";

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

function buildCityResourceInputs(
  city: CityState,
  resource: Resource,
  moraleBonusN: number,
  buildingEffects: CityResourceInputs["buildingEffects"]
): CityResourceInputs {
  const moraleParams = city.moraleParams ?? {
    S: STARTING_MORALE_DAY1,
    T: HOMELAND_TARGET_MORALE,
    N: 0,
    D: DEFAULT_MORALE_DECAY_D,
  };

  return {
    resource,
    startPop: city.startPop,
    moraleParams: {
      ...moraleParams,
      N: (moraleParams.N ?? 0) + moraleBonusN,
    },
    ecoInfraMultiplier: city.ecoInfraMultiplier,
    hiddenMultiplierOverride: city.hiddenMultiplierOverride,
    populationMode: city.populationMode,
    populationOpts: city.populationOpts,
    multiplierByPop: city.multiplierByPop,
    buildingEffects,
  };
}

export function simulateBuildOrder(args: {
  cities: CityState[];
  buildOrder: BuildAction[];
  buildings: BuildingsFile;
  scenario: ScenarioStartLike & { speed: GameSpeed };
  hoursToSimulate: number;
}): SimulationResult {
  if (!Number.isFinite(args.hoursToSimulate) || args.hoursToSimulate < 0) {
    throw new Error(`hoursToSimulate must be >= 0, got ${args.hoursToSimulate}`);
  }

  const segmentsByCity = scheduleBuildSegments({
    cities: args.cities,
    buildOrder: args.buildOrder,
    buildings: args.buildings,
    scenario: args.scenario,
  });
  const perHourPerCity: HourlyCityResult[] = [];
  const debug: SimulationResult["debug"] = [];
  const timingDays: SimulationResult["timingDebug"]["days"] = [];

  for (let hour = 0; hour < args.hoursToSimulate; hour++) {
    for (const city of args.cities) {
      const absoluteHour = scenarioStartAbsoluteHour(args.scenario) + hour;
      const mapDay = Math.floor(absoluteHour / 24) + 1;
      const dayStartAbs = (mapDay - 1) * 24;
      const citySegments = segmentsByCity.get(city.cityId) ?? {
        arms_industry: [],
        underground_bunkers: [],
      };
      const state = getBuildingStateAtHourEnd({
        hour,
        segments: citySegments.arms_industry,
        scenario: args.scenario,
      });
      const bunkerLevelAtDayStart = getCompletedBuildingLevelAtDayStart({
        mapDay,
        startingLevel: city.buildings.underground_bunkers,
        segments: citySegments.underground_bunkers,
      });
      const bunkerEffects = getEconomicBuildingEffectsForLevels(args.buildings, {
        underground_bunkers: bunkerLevelAtDayStart,
      });
      const buildingEffects = interpolateArmsIndustryEffects(args.buildings, {
        fromLevel: state.currentFromLevel,
        toLevel: state.currentToLevel,
        progressRatio: state.progressRatio,
        flatBonusLevel: state.flatCashActiveLevel,
      });
      const dynamicBuildingEffects = {
        productionBonusPct: buildingEffects.productionBonusPct,
        flatBonuses: { ...buildingEffects.flatBonuses },
        moraleBonusN: bunkerEffects.moraleBonusN,
      };
      const debugCityInputs = buildCityResourceInputs(
        city,
        city.resource,
        bunkerEffects.moraleBonusN,
        dynamicBuildingEffects
      );
      const morale = moraleOnDay(mapDay, debugCityInputs.moraleParams);
      const moraleMultiplier = moraleProductionMultiplier(morale);
      const multiplier = moraleMultiplier * (1 + buildingEffects.productionBonusPct);
      const production = zeroProduction();
      const producedResources: Resource[] = [city.resource, "cash", "manpower"];

      for (const resource of producedResources) {
        const cityInputs = buildCityResourceInputs(
          city,
          resource,
          bunkerEffects.moraleBonusN,
          dynamicBuildingEffects
        );
        production[resource] = hourlyResourcePointAtAbsoluteHour(
          args.scenario.speed,
          cityInputs,
          absoluteHour
        ).amount;
      }

      perHourPerCity.push({
        hour,
        cityId: city.cityId,
        effectiveBonusPct: buildingEffects.productionBonusPct,
        multiplier,
        flatCash: buildingEffects.flatBonuses.cash ?? 0,
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
        bunkerMoraleBonusN: bunkerEffects.moraleBonusN,
        absoluteHour,
        dayIndex: mapDay,
        dayStartAbsoluteHour: dayStartAbs,
      });

      if (!timingDays.some(entry => entry.cityId === city.cityId && entry.dayIndex === mapDay)) {
        timingDays.push({
          cityId: city.cityId,
          dayIndex: mapDay,
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
          activationDay: Math.floor((segment.endMinute / 60) / 24) + 1,
        })),
      days: timingDays,
    },
  };
}
