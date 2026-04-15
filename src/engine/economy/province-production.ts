import {
  BASE_PROVINCE_MANPOWER_PRODUCTION,
  BASE_PROVINCE_RESOURCE_PRODUCTION,
  CITY_STATUS_MULTIPLIER,
  GAME_SPEED_MULTIPLIER,
  type CityStatus,
  type GameSpeed,
  type Resource,
} from "../../core/constants.js";
import {
  moraleOnDay,
  moraleProductionMultiplier,
  type MoraleParams,
} from "./morale.js";
import type { BuildingsFile } from "../../schemas/building-schema.js";
import {
  buildingMoraleBonusN,
  getEconomicBuildingEffectsForLevels,
  type EconomicBuildingEffects,
} from "./building-modifiers.js";

export type ProvinceResourceInputs = {
  resource: Resource;
  provinceCount: number;
  moraleParams: MoraleParams;
  buildingEffects?: Pick<EconomicBuildingEffects, "moraleBonusN" | "productionBonusPct">;
  buildingsFile?: BuildingsFile;
  combatOutpostLevel?: number;
  localIndustryLevel?: number;
  moraleOverride?: number;
  hiddenMultiplierOverride?: number;
  cityStatus?: CityStatus;
};

export type DailyProvinceResourceRow = {
  day: number;
  amount: number;
};

export type DailyProvinceResourceTable = {
  rows: DailyProvinceResourceRow[];
  total: number;
};

export type HourlyProvinceResourceRow = {
  hour: number;
  day: number;
  hourOfDay: number;
  amount: number;
};

export type HourlyProvinceResourceTable = {
  rows: HourlyProvinceResourceRow[];
  total: number;
};

export type HourlyProvinceResourcePoint = {
  day: number;
  hourOfDay: number;
  amount: number;
};

function floorInt(x: number) {
  return Math.floor(x);
}

function provinceBaseAmount(resource: Resource, provinceCount: number) {
  if (resource === "manpower") {
    return BASE_PROVINCE_MANPOWER_PRODUCTION * provinceCount;
  }

  return BASE_PROVINCE_RESOURCE_PRODUCTION[resource] * provinceCount;
}

function provinceResourceProductionMultiplier(province: ProvinceResourceInputs) {
  if (province.buildingEffects) {
    return province.resource === "cash" || province.resource === "manpower"
      ? 1
      : 1 + (province.buildingEffects.productionBonusPct ?? 0);
  }
  if (province.resource === "cash" || province.resource === "manpower") {
    return 1;
  }
  if (!province.buildingsFile || !province.localIndustryLevel || province.localIndustryLevel <= 0) {
    return 1;
  }
  return 1 + (
    getEconomicBuildingEffectsForLevels(province.buildingsFile, {
      local_industry: province.localIndustryLevel,
    }).productionBonusPct
  );
}

function provinceMoraleBonusN(province: ProvinceResourceInputs) {
  if (province.buildingEffects) {
    return province.buildingEffects.moraleBonusN ?? 0;
  }
  if (!province.buildingsFile || !province.combatOutpostLevel || province.combatOutpostLevel <= 0) {
    return 0;
  }

  return buildingMoraleBonusN(
    province.buildingsFile,
    "combat_outpost",
    province.combatOutpostLevel
  );
}

export function buildDailyProvinceResourceTable(
  days: number,
  gameSpeed: GameSpeed,
  province: ProvinceResourceInputs
): DailyProvinceResourceTable {
  if (!Number.isFinite(days) || days < 1) {
    throw new Error(`days must be >= 1, got ${days}`);
  }
  if (!Number.isFinite(province.provinceCount) || province.provinceCount < 0) {
    throw new Error(`provinceCount must be >= 0, got ${province.provinceCount}`);
  }

  const speedMul = GAME_SPEED_MULTIPLIER[gameSpeed];
  if (speedMul === undefined) {
    throw new Error(`Unknown gameSpeed="${gameSpeed}"`);
  }

  const hidden = province.hiddenMultiplierOverride ?? speedMul;
  const cityStatusMultiplier = CITY_STATUS_MULTIPLIER[province.cityStatus ?? "homeland"];
  const rows: DailyProvinceResourceRow[] = [];
  let total = 0;

  for (let day = 1; day <= days; day++) {
    const morale =
      province.moraleOverride ??
      moraleOnDay(day, {
        ...province.moraleParams,
        N: (province.moraleParams.N ?? 0) + provinceMoraleBonusN(province),
      });
    const moraleMul = moraleProductionMultiplier(morale);
    const productionMultiplier = provinceResourceProductionMultiplier(province);
    const amount = floorInt(
      provinceBaseAmount(province.resource, province.provinceCount) *
        moraleMul *
        hidden *
        productionMultiplier *
        cityStatusMultiplier
    );

    rows.push({ day, amount });
    total += amount;
  }

  return { rows, total };
}

export function buildHourlyProvinceResourceTable(
  days: number,
  gameSpeed: GameSpeed,
  province: ProvinceResourceInputs,
  opts?: {
    startAbsoluteHour?: number;
  }
): HourlyProvinceResourceTable {
  const startAbsoluteHour = opts?.startAbsoluteHour ?? 0;
  const rows: HourlyProvinceResourceRow[] = [];
  let total = 0;

  for (let index = 0; index < days * 24; index++) {
    const absoluteHour = startAbsoluteHour + index;
    const point = hourlyProvinceResourcePointAtAbsoluteHour(gameSpeed, province, absoluteHour);

    rows.push({
      hour: index + 1,
      day: point.day,
      hourOfDay: point.hourOfDay,
      amount: point.amount,
    });
    total += point.amount;
  }

  return { rows, total };
}

export function hourlyProvinceResourcePointAtAbsoluteHour(
  gameSpeed: GameSpeed,
  province: ProvinceResourceInputs,
  absoluteHour: number
): HourlyProvinceResourcePoint {
  const speedMul = GAME_SPEED_MULTIPLIER[gameSpeed];
  if (speedMul === undefined) {
    throw new Error(`Unknown gameSpeed="${gameSpeed}"`);
  }

  const hidden = province.hiddenMultiplierOverride ?? speedMul;
  const cityStatusMultiplier = CITY_STATUS_MULTIPLIER[province.cityStatus ?? "homeland"];
  const day = Math.floor(absoluteHour / 24) + 1;
  const hourOfDay = (absoluteHour % 24) + 1;
  const morale =
    province.moraleOverride ??
    moraleOnDay(day, {
      ...province.moraleParams,
      N: (province.moraleParams.N ?? 0) + provinceMoraleBonusN(province),
    });
  const moraleMul = moraleProductionMultiplier(morale);
  const productionMultiplier = provinceResourceProductionMultiplier(province);
  const dailyAmount = floorInt(
    provinceBaseAmount(province.resource, province.provinceCount) *
      moraleMul *
      hidden *
      productionMultiplier *
      cityStatusMultiplier
  );

  return {
    day,
    hourOfDay,
    amount: floorInt(dailyAmount / 24),
  };
}
