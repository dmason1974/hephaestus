import type { BuildingsFile } from "../../schemas/building-schema.js";
import {
  defaultStartingMoraleForCityStatus,
  defaultStartingPopulationForCityStatus,
  DEFAULT_MORALE_DECAY_D,
  HOMELAND_TARGET_MORALE,
  STARTING_MORALE_DAY1,
  type CityStatus,
  type GameSpeed,
  type Resource as EconomyResource,
  type StartingPopulation,
} from "../../core/constants.js";
import { scenarioStartAbsoluteHour, type ScenarioStartLike } from "../../core/time.js";
import {
  annexCityStatusShiftPct,
  buildingMoraleBonusN,
  interpolateEconomicBuildingEffects,
  getEconomicBuildingEffectsForLevels,
  undergroundBunkerMoraleBonusN,
  type EconomicBuildingEffects,
} from "../economy/building-modifiers.js";
import {
  hourlyResourcePointAtAbsoluteHour,
  type CityResourceInputs,
} from "../economy/city-production.js";
import {
  moraleOnDayWithDynamicBonus,
  moraleProductionMultiplier,
  type MoraleParams,
} from "../economy/morale.js";
import {
  getBuildingStateAtHourEnd,
  getCompletedBuildingLevelAtHourEnd,
  getCompletedBuildingLevelAtHourStart,
  getCompletedBuildingLevelAtDayStart,
  scheduleBuildSegments,
  type BuildAction,
  type BuildingLevels,
} from "../orchestration/build-order-timeline.js";

export type Resource = EconomyResource;
type ProducedResource = Exclude<Resource, "cash" | "manpower">;

export type CityState = {
  cityId: string;
  countryId?: string;
  capital?: boolean;
  resource: ProducedResource;
  startPop: StartingPopulation;
  buildings: BuildingLevels;
  cityStatus?: CityStatus;
  moraleParams?: MoraleParams;
  ecoInfraMultiplier?: CityResourceInputs["ecoInfraMultiplier"];
  hiddenMultiplierOverride?: CityResourceInputs["hiddenMultiplierOverride"];
  populationMode?: CityResourceInputs["populationMode"];
  populationOpts?: CityResourceInputs["populationOpts"];
  multiplierByPop?: CityResourceInputs["multiplierByPop"];
};
export type { BuildAction } from "../orchestration/build-order-timeline.js";

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
      buildingId: BuildAction["buildingId"];
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

function zeroEconomicEffects(): EconomicBuildingEffects {
  return {
    productionBonusPct: 0,
    manpowerBonusPct: 0,
    populationBonusPct: 0,
    flatBonuses: {},
    moraleBonusN: 0,
  };
}

function addEconomicEffects(target: EconomicBuildingEffects, source: EconomicBuildingEffects) {
  target.productionBonusPct += source.productionBonusPct;
  target.manpowerBonusPct += source.manpowerBonusPct;
  target.populationBonusPct += source.populationBonusPct;
  target.moraleBonusN += source.moraleBonusN;

  for (const [resource, amount] of Object.entries(source.flatBonuses) as Array<[Resource, number | undefined]>) {
    if (!Number.isFinite(amount ?? NaN)) continue;
    target.flatBonuses[resource] = (target.flatBonuses[resource] ?? 0) + (amount ?? 0);
  }
}

function buildCityResourceInputs(
  city: CityState,
  cityStatus: CityStatus,
  resource: Resource,
  moraleOverride: number | undefined,
  moraleBonusN: number,
  buildingEffects: CityResourceInputs["buildingEffects"]
): CityResourceInputs {
  const moraleParams = city.moraleParams ?? {
    S: defaultStartingMoraleForCityStatus(cityStatus),
    T: HOMELAND_TARGET_MORALE,
    N: 0,
    D: DEFAULT_MORALE_DECAY_D,
  };

  return {
    resource,
    startPop: defaultStartingPopulationForCityStatus(city.startPop, cityStatus),
    moraleOverride,
    moraleParams: {
      ...moraleParams,
      N: (moraleParams.N ?? 0) + moraleBonusN,
    },
    ecoInfraMultiplier: city.ecoInfraMultiplier,
    hiddenMultiplierOverride: city.hiddenMultiplierOverride,
    populationMode: city.populationMode,
    populationOpts: city.populationOpts,
    multiplierByPop: city.multiplierByPop,
    cityStatus,
    buildingEffects,
  };
}

function interpolatedEconomicEffectsForBuilding(args: {
  buildings: BuildingsFile;
  buildingId: "air_base" | "arms_industry" | "military_hospital" | "naval_base";
  startingLevel: number;
  segments: ReturnType<typeof scheduleBuildSegments> extends Map<string, infer T>
    ? T[keyof T]
    : never;
  hour: number;
  scenario: ScenarioStartLike;
}) {
  const state = getBuildingStateAtHourEnd({
    hour: args.hour,
    segments: args.segments,
    scenario: args.scenario,
    startingLevel: args.startingLevel,
  });

  return {
    state,
    effects: interpolateEconomicBuildingEffects(args.buildings, {
      buildingId: args.buildingId,
      fromLevel: state.currentFromLevel,
      toLevel: state.currentToLevel,
      progressRatio: state.progressRatio,
    }),
  };
}

function countryKey(city: Pick<CityState, "countryId">) {
  return city.countryId ?? "__default_country__";
}

function activeHeadquartersCityId(args: {
  cities: CityState[];
  cityId: string;
  absoluteHour: number;
  scenario: ScenarioStartLike;
  segmentsByCity: ReturnType<typeof scheduleBuildSegments>;
}) {
  const sourceCity = args.cities.find(city => city.cityId === args.cityId);
  if (!sourceCity) {
    throw new Error(`unknown cityId "${args.cityId}" in simulation`);
  }

  const siblingCities = args.cities.filter(city => countryKey(city) === countryKey(sourceCity));
  let activeCityId = siblingCities.find(city => city.capital)?.cityId;
  let latestCompletionMinute = -1;

  for (const city of siblingCities) {
    const citySegments = args.segmentsByCity.get(city.cityId);
    const completedLevel = getCompletedBuildingLevelAtHourEnd({
      hour: args.absoluteHour - scenarioStartAbsoluteHour(args.scenario),
      startingLevel: city.buildings.relocate_headquarters,
      segments: citySegments?.relocate_headquarters ?? [],
      scenario: args.scenario,
    });
    if (completedLevel <= 0) continue;

    const completedSegment = (citySegments?.relocate_headquarters ?? [])
      .filter(segment => segment.endMinute < ((args.absoluteHour) * 60))
      .at(-1);
    if (!completedSegment) continue;
    if (completedSegment.endMinute <= latestCompletionMinute) continue;

    latestCompletionMinute = completedSegment.endMinute;
    activeCityId = city.cityId;
  }

  return activeCityId;
}

function effectiveCityStatusAtHourEnd(args: {
  buildings: BuildingsFile;
  city: CityState;
  hour: number;
  scenario: ScenarioStartLike;
  segmentsByCity: ReturnType<typeof scheduleBuildSegments>;
}): CityStatus {
  const startingStatus = args.city.cityStatus ?? "homeland";
  if (startingStatus !== "occupied") return startingStatus;

  const annexLevel = getCompletedBuildingLevelAtHourEnd({
    hour: args.hour,
    startingLevel: args.city.buildings.annex_city,
    segments: args.segmentsByCity.get(args.city.cityId)?.annex_city ?? [],
    scenario: args.scenario,
  });

  return annexLevel > 0 && annexCityStatusShiftPct(args.buildings, annexLevel) > 0
    ? "annexed"
    : "occupied";
}

function moraleBonusForDay(args: {
  buildings: BuildingsFile;
  cities: CityState[];
  city: CityState;
  mapDay: number;
  scenario: ScenarioStartLike;
  segmentsByCity: ReturnType<typeof scheduleBuildSegments>;
}) {
  const citySegments = args.segmentsByCity.get(args.city.cityId);
  const bunkerLevelAtDayStart = getCompletedBuildingLevelAtDayStart({
    mapDay: args.mapDay,
    startingLevel: args.city.buildings.underground_bunkers,
    segments: citySegments?.underground_bunkers ?? [],
  });
  const headquartersBonus =
    activeHeadquartersCityId({
      cities: args.cities,
      cityId: args.city.cityId,
      absoluteHour: (args.mapDay - 1) * 24,
      scenario: args.scenario,
      segmentsByCity: args.segmentsByCity,
    }) === args.city.cityId
      ? buildingMoraleBonusN(args.buildings, "relocate_headquarters", 1)
      : 0;

  return undergroundBunkerMoraleBonusN(args.buildings, bunkerLevelAtDayStart) + headquartersBonus;
}

export function simulateBuildOrder(args: {
  cities: CityState[];
  buildOrder: BuildAction[];
  buildings: BuildingsFile;
  scenario: ScenarioStartLike & { speed: GameSpeed };
  hoursToSimulate: number;
  /**
   * Per-city absolute hour after which air_base's economic contribution (production
   * bonus) is zeroed, regardless of its tracked level. Does not affect
   * `airBase.state`/level-tracking, only the production-side economic effect — models
   * "the building is destroyed" for income purposes without touching build-chain
   * eligibility elsewhere (the Iron Pipeline's force-projection chain never credited
   * a city's starting air_base anyway — see CLAUDE.md's garrison/airport-demolish
   * section). Absent (default) ⇒ no behavior change.
   */
  forcedAirBaseDestructionAbsHour?: Record<string, number>;
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
  const scenarioStartAbsHour = scenarioStartAbsoluteHour(args.scenario);

  for (let hour = 0; hour < args.hoursToSimulate; hour++) {
    for (const city of args.cities) {
      const absoluteHour = scenarioStartAbsHour + hour;
      const mapDay = Math.floor(absoluteHour / 24) + 1;
      const dayStartAbs = (mapDay - 1) * 24;
      const effectiveCityStatus = effectiveCityStatusAtHourEnd({
        buildings: args.buildings,
        city,
        hour,
        scenario: args.scenario,
        segmentsByCity,
      });
      const citySegments = segmentsByCity.get(city.cityId) ?? {
        air_base: [],
        annex_city: [],
        arms_industry: [],
        military_hospital: [],
        naval_base: [],
        recruiting_office: [],
        relocate_headquarters: [],
        secret_weapons_lab: [],
        underground_bunkers: [],
      };
      const airBase = interpolatedEconomicEffectsForBuilding({
        buildings: args.buildings,
        buildingId: "air_base",
        startingLevel: city.buildings.air_base,
        segments: citySegments.air_base,
        hour,
        scenario: args.scenario,
      });
      const armsIndustry = interpolatedEconomicEffectsForBuilding({
        buildings: args.buildings,
        buildingId: "arms_industry",
        startingLevel: city.buildings.arms_industry,
        segments: citySegments.arms_industry,
        hour,
        scenario: args.scenario,
      });
      const navalBase = interpolatedEconomicEffectsForBuilding({
        buildings: args.buildings,
        buildingId: "naval_base",
        startingLevel: city.buildings.naval_base,
        segments: citySegments.naval_base,
        hour,
        scenario: args.scenario,
      });
      const militaryHospital = interpolatedEconomicEffectsForBuilding({
        buildings: args.buildings,
        buildingId: "military_hospital",
        startingLevel: city.buildings.military_hospital ?? 0,
        segments: citySegments.military_hospital,
        hour,
        scenario: args.scenario,
      });
      const bunkerLevelAtDayStart = getCompletedBuildingLevelAtDayStart({
        mapDay,
        startingLevel: city.buildings.underground_bunkers,
        segments: citySegments.underground_bunkers,
      });
      const recruitingOfficeLevel = getCompletedBuildingLevelAtHourStart({
        hour,
        startingLevel: city.buildings.recruiting_office,
        segments: citySegments.recruiting_office,
        scenario: args.scenario,
      });
      const bunkerEffects = getEconomicBuildingEffectsForLevels(args.buildings, {
        underground_bunkers: bunkerLevelAtDayStart,
      });
      const recruitingOfficeEffects = getEconomicBuildingEffectsForLevels(args.buildings, {
        recruiting_office: recruitingOfficeLevel,
      });
      const airBaseDestructionHour = args.forcedAirBaseDestructionAbsHour?.[city.cityId];
      const airBaseEffects =
        airBaseDestructionHour !== undefined && absoluteHour >= airBaseDestructionHour
          ? zeroEconomicEffects()
          : airBase.effects;
      const dynamicBuildingEffects = zeroEconomicEffects();
      addEconomicEffects(dynamicBuildingEffects, airBaseEffects);
      addEconomicEffects(dynamicBuildingEffects, armsIndustry.effects);
      addEconomicEffects(dynamicBuildingEffects, militaryHospital.effects);
      addEconomicEffects(dynamicBuildingEffects, navalBase.effects);
      addEconomicEffects(dynamicBuildingEffects, bunkerEffects);
      addEconomicEffects(dynamicBuildingEffects, recruitingOfficeEffects);
      const baseMoraleParams = city.moraleParams ?? {
        S: defaultStartingMoraleForCityStatus(effectiveCityStatus),
        T: HOMELAND_TARGET_MORALE,
        N: 0,
        D: DEFAULT_MORALE_DECAY_D,
      };
      const morale = moraleOnDayWithDynamicBonus(mapDay, {
        ...baseMoraleParams,
        bonusForDay: day =>
          moraleBonusForDay({
            buildings: args.buildings,
            cities: args.cities,
            city,
            mapDay: day,
            scenario: args.scenario,
            segmentsByCity,
          }),
      });
      const moraleMultiplier = moraleProductionMultiplier(morale);
      const multiplier = moraleMultiplier * (1 + dynamicBuildingEffects.productionBonusPct);
      const production = zeroProduction();
      const producedResources: Resource[] = [city.resource, "cash", "manpower"];

      for (const resource of producedResources) {
        const cityInputs = buildCityResourceInputs(
          city,
          effectiveCityStatus,
          resource,
          morale,
          0,
          dynamicBuildingEffects
        );
        production[resource] = hourlyResourcePointAtAbsoluteHour(
          args.scenario.speed,
          cityInputs,
          absoluteHour,
          scenarioStartAbsHour
        ).amount;
      }

      perHourPerCity.push({
        hour,
        cityId: city.cityId,
        effectiveBonusPct: dynamicBuildingEffects.productionBonusPct,
        multiplier,
        flatCash: dynamicBuildingEffects.flatBonuses.cash ?? 0,
        production,
      });

      debug.push({
        hour,
        cityId: city.cityId,
        currentFromLevel: armsIndustry.state.currentFromLevel,
        currentToLevel: armsIndustry.state.currentToLevel,
        progressRatio: armsIndustry.state.progressRatio,
        segmentStartMinute: armsIndustry.state.segmentStartMinute,
        segmentEndMinute: armsIndustry.state.segmentEndMinute,
        flatCashActiveLevel: armsIndustry.state.flatCashActiveLevel,
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
        .flatMap(citySegments => [
          ...citySegments.air_base,
          ...citySegments.army_base,
          ...citySegments.arms_industry,
          ...citySegments.naval_base,
          ...citySegments.recruiting_office,
          ...citySegments.relocate_headquarters,
          ...citySegments.secret_weapons_lab,
          ...citySegments.underground_bunkers,
        ])
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
