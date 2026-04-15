import type { BuildingsFile } from "../../schemas/building-schema.js";
import {
  defaultStartingMoraleForCityStatus,
  DEFAULT_MORALE_DECAY_D,
  HOMELAND_TARGET_MORALE,
  STARTING_MORALE_DAY1,
  type CityStatus,
  type GameSpeed,
  type Resource,
} from "../../core/constants.js";
import { scenarioStartAbsoluteHour, type ScenarioStartLike } from "../../core/time.js";
import {
  getEconomicBuildingEffectsForLevels,
  interpolateEconomicBuildingEffects,
  type EconomicBuildingEffects,
} from "../economy/building-modifiers.js";
import {
  hourlyProvinceResourcePointAtAbsoluteHour,
  type ProvinceResourceInputs,
} from "../economy/province-production.js";
import {
  moraleOnDayWithDynamicBonus,
  type MoraleParams,
} from "../economy/morale.js";
import {
  getBuildingStateAtHourEnd,
  getCompletedBuildingLevelAtDayStart,
  scheduleBuildSegments,
  type BuildAction,
  type BuildingLevels,
} from "../orchestration/build-order-timeline.js";

type ProvinceProducedResource = Exclude<Resource, "cash" | "manpower">;

export type ProvinceState = {
  provinceId: string;
  countryId?: string;
  resource: ProvinceProducedResource | null;
  resourceProvinceCount: number;
  totalProvinceCount: number;
  buildings: Pick<BuildingLevels, "combat_outpost" | "local_industry">;
  cityStatus?: CityStatus;
  moraleParams?: MoraleParams;
  hiddenMultiplierOverride?: ProvinceResourceInputs["hiddenMultiplierOverride"];
};

export type ProvinceBuildAction = {
  provinceId: string;
  buildingId: "combat_outpost" | "local_industry";
  targetLevel: number;
  startRelHour?: number;
  startHour?: number;
};

export type HourlyProvinceResult = {
  hour: number;
  provinceId: string;
  effectiveBonusPct: number;
  production: Record<Resource, number>;
};

export type ProvinceSimulationResult = {
  hoursSimulated: number;
  perHourPerProvince: HourlyProvinceResult[];
  perHourAggregate: Array<{ hour: number; production: Record<Resource, number> }>;
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
    flatBonuses: {},
    moraleBonusN: 0,
  };
}

function addEconomicEffects(target: EconomicBuildingEffects, source: EconomicBuildingEffects) {
  target.productionBonusPct += source.productionBonusPct;
  target.manpowerBonusPct += source.manpowerBonusPct;
  target.moraleBonusN += source.moraleBonusN;
}

function provinceToTimelineState(province: ProvinceState) {
  return {
    cityId: province.provinceId,
    countryId: province.countryId,
    cityStatus: province.cityStatus,
    moraleParams: province.moraleParams,
    buildings: {
      army_base: 0,
      air_base: 0,
      annex_city: 0,
      arms_industry: 0,
      combat_outpost: province.buildings.combat_outpost ?? 0,
      local_industry: province.buildings.local_industry ?? 0,
      naval_base: 0,
      recruiting_office: 0,
      relocate_headquarters: 0,
      underground_bunkers: 0,
    },
  };
}

function interpolatedProvinceEffectsForBuilding(args: {
  buildings: BuildingsFile;
  buildingId: "local_industry";
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

export function simulateProvinceBuildOrder(args: {
  provinces: ProvinceState[];
  buildOrder: ProvinceBuildAction[];
  buildings: BuildingsFile;
  scenario: ScenarioStartLike & { speed: GameSpeed };
  hoursToSimulate: number;
}): ProvinceSimulationResult {
  if (!Number.isFinite(args.hoursToSimulate) || args.hoursToSimulate < 0) {
    throw new Error(`hoursToSimulate must be >= 0, got ${args.hoursToSimulate}`);
  }

  const timelineProvinces = args.provinces.map(provinceToTimelineState);
  const timelineBuildOrder: BuildAction[] = args.buildOrder.map(action => ({
    cityId: action.provinceId,
    buildingId: action.buildingId,
    targetLevel: action.targetLevel,
    startRelHour: action.startRelHour,
    startHour: action.startHour,
  }));
  const segmentsByProvince = scheduleBuildSegments({
    cities: timelineProvinces,
    buildOrder: timelineBuildOrder,
    buildings: args.buildings,
    scenario: args.scenario,
  });

  const perHourPerProvince: HourlyProvinceResult[] = [];

  for (let hour = 0; hour < args.hoursToSimulate; hour++) {
    for (const province of args.provinces) {
      const absoluteHour = scenarioStartAbsoluteHour(args.scenario) + hour;
      const mapDay = Math.floor(absoluteHour / 24) + 1;
      const provinceSegments = segmentsByProvince.get(province.provinceId) ?? {
        army_base: [],
        air_base: [],
        annex_city: [],
        arms_industry: [],
        combat_outpost: [],
        local_industry: [],
        naval_base: [],
        recruiting_office: [],
        relocate_headquarters: [],
        underground_bunkers: [],
      };
      const localIndustry = interpolatedProvinceEffectsForBuilding({
        buildings: args.buildings,
        buildingId: "local_industry",
        startingLevel: province.buildings.local_industry ?? 0,
        segments: provinceSegments.local_industry,
        hour,
        scenario: args.scenario,
      });
      const combatOutpostLevelAtDayStart = getCompletedBuildingLevelAtDayStart({
        mapDay,
        startingLevel: province.buildings.combat_outpost ?? 0,
        segments: provinceSegments.combat_outpost,
      });
      const combatOutpostEffects = getEconomicBuildingEffectsForLevels(args.buildings, {
        combat_outpost: combatOutpostLevelAtDayStart,
      });
      const dynamicEffects = zeroEconomicEffects();
      addEconomicEffects(dynamicEffects, localIndustry.effects);
      addEconomicEffects(dynamicEffects, combatOutpostEffects);

      const moraleParams = province.moraleParams ?? {
        S: defaultStartingMoraleForCityStatus(province.cityStatus),
        T: HOMELAND_TARGET_MORALE,
        N: 0,
        D: DEFAULT_MORALE_DECAY_D,
      };
      const morale = moraleOnDayWithDynamicBonus(mapDay, {
        ...moraleParams,
        bonusForDay: () => dynamicEffects.moraleBonusN,
      });

      const production = zeroProduction();
      const resources: Resource[] = [
        ...(province.resource ? [province.resource] : []),
        "cash",
        "manpower",
      ];
      for (const resource of resources) {
        const provinceCount =
          resource === "cash" || resource === "manpower"
            ? province.totalProvinceCount
            : province.resourceProvinceCount;

        production[resource] = hourlyProvinceResourcePointAtAbsoluteHour(
          args.scenario.speed,
          {
            resource,
            provinceCount,
            moraleParams,
            moraleOverride: morale,
            hiddenMultiplierOverride: province.hiddenMultiplierOverride,
            cityStatus: province.cityStatus,
            buildingEffects: {
              productionBonusPct: dynamicEffects.productionBonusPct,
              moraleBonusN: dynamicEffects.moraleBonusN,
            },
          },
          absoluteHour
        ).amount;
      }

      perHourPerProvince.push({
        hour,
        provinceId: province.provinceId,
        effectiveBonusPct: dynamicEffects.productionBonusPct,
        production,
      });
    }
  }

  const perHourAggregate = Array.from({ length: args.hoursToSimulate }, (_, hour) => {
    const production = zeroProduction();
    for (const provinceResult of perHourPerProvince) {
      if (provinceResult.hour !== hour) continue;
      for (const resource of RESOURCE_KEYS) {
        production[resource] += provinceResult.production[resource];
      }
    }
    return { hour, production };
  });

  return {
    hoursSimulated: args.hoursToSimulate,
    perHourPerProvince,
    perHourAggregate,
  };
}
