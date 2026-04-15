import type { Resource } from "../../core/constants.js";
import type { BuildingsFile } from "../../schemas/building-schema.js";

export type EconomicBuildingEffects = {
  productionBonusPct: number;
  manpowerBonusPct: number;
  populationBonusPct: number;
  flatBonuses: Partial<Record<Resource, number>>;
  moraleBonusN: number;
};

export type StaticEconomicBuildingLevels = {
  air_base?: number;
  arms_industry?: number;
  combat_outpost?: number;
  local_industry?: number;
  military_hospital?: number;
  naval_base?: number;
  recruiting_office?: number;
  underground_bunkers?: number;
};

export type InterpolatedArmsIndustryLevels = {
  fromLevel: number;
  toLevel: number;
  progressRatio: number;
  flatBonusLevel?: number;
};

export type InterpolatedEconomicBuildingLevels = {
  buildingId: "air_base" | "arms_industry" | "local_industry" | "military_hospital" | "naval_base";
  fromLevel: number;
  toLevel: number;
  progressRatio: number;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function zeroEconomicBuildingEffects(): EconomicBuildingEffects {
  return {
    productionBonusPct: 0,
    manpowerBonusPct: 0,
    populationBonusPct: 0,
    flatBonuses: {},
    moraleBonusN: 0,
  };
}

function addFlatBonuses(
  target: Partial<Record<Resource, number>>,
  source?: Partial<Record<Resource, number>>
) {
  if (!source) return;

  for (const [resource, amount] of Object.entries(source) as Array<[Resource, number | undefined]>) {
    if (!Number.isFinite(amount ?? NaN)) continue;
    target[resource] = (target[resource] ?? 0) + (amount ?? 0);
  }
}

function interpolateFlatBonuses(
  from: Partial<Record<Resource, number>>,
  to: Partial<Record<Resource, number>>,
  ratio: number
) {
  const resources = new Set<Resource>([
    ...(Object.keys(from) as Resource[]),
    ...(Object.keys(to) as Resource[]),
  ]);
  const result: Partial<Record<Resource, number>> = {};

  for (const resource of resources) {
    const fromAmount = from[resource] ?? 0;
    const toAmount = to[resource] ?? 0;
    const interpolated = fromAmount + ((toAmount - fromAmount) * ratio);
    if (interpolated !== 0) {
      result[resource] = interpolated;
    }
  }

  return result;
}

function buildingLevelEffect(
  buildings: BuildingsFile,
  buildingId: string,
  level: number
): EconomicBuildingEffects {
  const clampedLevel = clamp(Math.floor(level), 0, 5);
  if (clampedLevel <= 0) return zeroEconomicBuildingEffects();

  const building = buildings.buildings[buildingId];
  if (!building) {
    return zeroEconomicBuildingEffects();
  }

  const levelData = building.levels[String(clampedLevel) as keyof typeof building.levels];
  if (!levelData) {
    return zeroEconomicBuildingEffects();
  }

  const productionBonusPct = Number.isFinite(levelData.production_bonus_pct ?? NaN)
    ? (levelData.production_bonus_pct ?? 0)
    : 0;
  const manpowerBonusPct = Number.isFinite(levelData.manpower_bonus_pct ?? NaN)
    ? (levelData.manpower_bonus_pct ?? 0)
    : 0;
  const populationBonusPct = Number.isFinite(levelData.population_bonus_pct ?? NaN)
    ? (levelData.population_bonus_pct ?? 0)
    : 0;
  const moraleBonusPct = Number.isFinite(levelData.morale_bonus_pct ?? NaN)
    ? (levelData.morale_bonus_pct ?? 0)
    : 0;

  return {
    productionBonusPct,
    manpowerBonusPct,
    populationBonusPct,
    flatBonuses: { ...(levelData.flat_bonus ?? {}) },
    moraleBonusN: Math.round(moraleBonusPct * 100),
  };
}

function armsIndustryLevelEffect(buildings: BuildingsFile, level: number): EconomicBuildingEffects {
  if (level <= 0) return zeroEconomicBuildingEffects();

  const building = buildings.buildings.arms_industry;
  if (!building) {
    throw new Error('buildings file is missing "arms_industry"');
  }

  const levelData = building.levels[String(level) as keyof typeof building.levels];
  if (!levelData) {
    throw new Error(`missing arms_industry level ${level} in buildings data`);
  }

  const productionBonusPct = Number.isFinite(levelData.production_bonus_pct ?? NaN)
    ? (levelData.production_bonus_pct ?? 0)
    : 0;
  const manpowerBonusPct = Number.isFinite(levelData.manpower_bonus_pct ?? NaN)
    ? (levelData.manpower_bonus_pct ?? 0)
    : 0;
  const populationBonusPct = Number.isFinite(levelData.population_bonus_pct ?? NaN)
    ? (levelData.population_bonus_pct ?? 0)
    : 0;

  return {
    productionBonusPct,
    manpowerBonusPct,
    populationBonusPct,
    flatBonuses: { ...(levelData.flat_bonus ?? {}) },
    moraleBonusN: 0,
  };
}

export function undergroundBunkerMoraleBonusN(buildings: BuildingsFile, level: number): number {
  const clampedLevel = clamp(Math.floor(level), 0, 5);
  if (clampedLevel <= 0) return 0;

  const building = buildings.buildings.underground_bunkers;
  if (!building) {
    throw new Error('buildings file is missing "underground_bunkers"');
  }

  const levelData = building.levels[String(clampedLevel) as keyof typeof building.levels];
  if (!levelData) {
    throw new Error(`missing underground_bunkers level ${clampedLevel} in buildings data`);
  }

  return Math.round((levelData.morale_bonus_pct ?? 0) * 100);
}

export function buildingMoraleBonusN(
  buildings: BuildingsFile,
  buildingId: string,
  level: number
): number {
  const clampedLevel = clamp(Math.floor(level), 0, 5);
  if (clampedLevel <= 0) return 0;

  const building = buildings.buildings[buildingId];
  if (!building) {
    return 0;
  }

  const levelData = building.levels[String(clampedLevel) as keyof typeof building.levels];
  if (!levelData) {
    return 0;
  }

  return Math.round((levelData.morale_bonus_pct ?? 0) * 100);
}

export function annexCityStatusShiftPct(
  buildings: BuildingsFile,
  level: number
): number {
  const clampedLevel = clamp(Math.floor(level), 0, 5);
  if (clampedLevel <= 0) return 0;

  const building = buildings.buildings.annex_city;
  if (!building) {
    return 0;
  }

  const levelData = building.levels[String(clampedLevel) as keyof typeof building.levels];
  if (!levelData) {
    return 0;
  }

  return levelData.city_status_pct ?? 0;
}

function undergroundBunkerLevelEffect(buildings: BuildingsFile, level: number): EconomicBuildingEffects {
  const effect = buildingLevelEffect(buildings, "underground_bunkers", level);
  return {
    productionBonusPct: effect.productionBonusPct,
    manpowerBonusPct: effect.manpowerBonusPct,
    populationBonusPct: effect.populationBonusPct,
    flatBonuses: effect.flatBonuses,
    moraleBonusN: undergroundBunkerMoraleBonusN(buildings, level),
  };
}

export function getEconomicBuildingEffectsForLevels(
  buildings: BuildingsFile,
  levels: StaticEconomicBuildingLevels
): EconomicBuildingEffects {
  const result = zeroEconomicBuildingEffects();
  const effects = [
    buildingLevelEffect(buildings, "air_base", levels.air_base ?? 0),
    armsIndustryLevelEffect(buildings, levels.arms_industry ?? 0),
    buildingLevelEffect(buildings, "combat_outpost", levels.combat_outpost ?? 0),
    buildingLevelEffect(buildings, "local_industry", levels.local_industry ?? 0),
    buildingLevelEffect(buildings, "military_hospital", levels.military_hospital ?? 0),
    buildingLevelEffect(buildings, "naval_base", levels.naval_base ?? 0),
    buildingLevelEffect(buildings, "recruiting_office", levels.recruiting_office ?? 0),
    undergroundBunkerLevelEffect(buildings, levels.underground_bunkers ?? 0),
  ];

  for (const effect of effects) {
    result.productionBonusPct += effect.productionBonusPct;
    result.manpowerBonusPct += effect.manpowerBonusPct;
    result.populationBonusPct += effect.populationBonusPct;
    addFlatBonuses(result.flatBonuses, effect.flatBonuses);
    result.moraleBonusN += effect.moraleBonusN;
  }

  return result;
}

export function interpolateEconomicBuildingEffects(
  buildings: BuildingsFile,
  args: InterpolatedEconomicBuildingLevels
): EconomicBuildingEffects {
  const fromLevel = clamp(args.fromLevel, 0, 5);
  const toLevel = clamp(args.toLevel, 0, 5);
  const ratio = clamp(args.progressRatio, 0, 1);
  const fromEffect = buildingLevelEffect(buildings, args.buildingId, fromLevel);
  const toEffect = buildingLevelEffect(buildings, args.buildingId, toLevel);

  return {
    productionBonusPct:
      fromEffect.productionBonusPct +
      ((toEffect.productionBonusPct - fromEffect.productionBonusPct) * ratio),
    manpowerBonusPct:
      fromEffect.manpowerBonusPct +
      ((toEffect.manpowerBonusPct - fromEffect.manpowerBonusPct) * ratio),
    populationBonusPct:
      fromEffect.populationBonusPct +
      ((toEffect.populationBonusPct - fromEffect.populationBonusPct) * ratio),
    flatBonuses: interpolateFlatBonuses(fromEffect.flatBonuses, toEffect.flatBonuses, ratio),
    moraleBonusN: fromEffect.moraleBonusN + ((toEffect.moraleBonusN - fromEffect.moraleBonusN) * ratio),
  };
}

export function interpolateArmsIndustryEffects(
  buildings: BuildingsFile,
  args: InterpolatedArmsIndustryLevels
): EconomicBuildingEffects {
  return interpolateEconomicBuildingEffects(buildings, {
    buildingId: "arms_industry",
    fromLevel: args.fromLevel,
    toLevel: args.toLevel,
    progressRatio: args.progressRatio,
  });
}
