import type { Resource } from "../../core/constants.js";
import type { BuildingsFile } from "../../schemas/building-schema.js";

export type EconomicBuildingEffects = {
  productionBonusPct: number;
  flatBonuses: Partial<Record<Resource, number>>;
  moraleBonusN: number;
};

export type StaticEconomicBuildingLevels = {
  air_base?: number;
  arms_industry?: number;
  naval_base?: number;
  underground_bunkers?: number;
};

export type InterpolatedArmsIndustryLevels = {
  fromLevel: number;
  toLevel: number;
  progressRatio: number;
  flatBonusLevel?: number;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function zeroEconomicBuildingEffects(): EconomicBuildingEffects {
  return {
    productionBonusPct: 0,
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

  return {
    productionBonusPct: levelData.production_bonus_pct ?? 0,
    flatBonuses: { ...(levelData.flat_bonus ?? {}) },
    moraleBonusN: Math.round((levelData.morale_bonus_pct ?? 0) * 100),
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

  return {
    productionBonusPct: levelData.production_bonus_pct ?? 0,
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

function undergroundBunkerLevelEffect(buildings: BuildingsFile, level: number): EconomicBuildingEffects {
  const effect = buildingLevelEffect(buildings, "underground_bunkers", level);
  return {
    productionBonusPct: effect.productionBonusPct,
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
    buildingLevelEffect(buildings, "naval_base", levels.naval_base ?? 0),
    undergroundBunkerLevelEffect(buildings, levels.underground_bunkers ?? 0),
  ];

  for (const effect of effects) {
    result.productionBonusPct += effect.productionBonusPct;
    addFlatBonuses(result.flatBonuses, effect.flatBonuses);
    result.moraleBonusN += effect.moraleBonusN;
  }

  return result;
}

export function interpolateArmsIndustryEffects(
  buildings: BuildingsFile,
  args: InterpolatedArmsIndustryLevels
): EconomicBuildingEffects {
  const fromLevel = clamp(args.fromLevel, 0, 5);
  const toLevel = clamp(args.toLevel, 0, 5);
  const ratio = clamp(args.progressRatio, 0, 1);
  const fromEffect = armsIndustryLevelEffect(buildings, fromLevel);
  const toEffect = armsIndustryLevelEffect(buildings, toLevel);
  const flatBonusLevel = args.flatBonusLevel ?? fromLevel;
  const flatBonusEffect = armsIndustryLevelEffect(buildings, flatBonusLevel);

  return {
    productionBonusPct:
      fromEffect.productionBonusPct +
      ((toEffect.productionBonusPct - fromEffect.productionBonusPct) * ratio),
    flatBonuses: { ...flatBonusEffect.flatBonuses },
    moraleBonusN: 0,
  };
}
