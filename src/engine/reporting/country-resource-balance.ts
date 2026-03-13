import {
  DEFAULT_MORALE_DECAY_D,
  HOMELAND_TARGET_MORALE,
  STARTING_MORALE_DAY1,
  type Resource,
  type StartingPopulation,
} from "../../core/constants.js";
import type { BuildingsFile } from "../../schemas/building-schema.js";
import type { Country } from "../../schemas/country-schema.js";
import type { ScenarioFile } from "../../schemas/scenario-schema.js";
import { resolveScenarioCityStatus, resolveScenarioHeadquartersCity } from "../../schemas/scenario-schema.js";
import {
  buildHourlyResourceTable,
  type CityResourceInputs,
} from "../economy/city-production.js";
import { buildingMoraleBonusN, getEconomicBuildingEffectsForLevels } from "../economy/building-modifiers.js";

export type CountryHourlyBalanceRow = {
  hour: number;
  day: number;
  hourOfDay: number;
  balances: Record<Resource, number>;
};

export type CountryHourlyBalanceTable = {
  rows: CountryHourlyBalanceRow[];
  endingBalances: Record<Resource, number>;
};

type CountryResourceBalanceOptions = {
  startingBalances?: Partial<Record<Resource, number>>;
  startAbsoluteHour?: number;
  buildingsFile: BuildingsFile;
  scenario?: ScenarioFile;
  cityDefaults?: Pick<
    CityResourceInputs,
    | "cityStatus"
    | "ecoInfraMultiplier"
    | "hiddenMultiplierOverride"
    | "populationMode"
    | "populationOpts"
    | "multiplierByPop"
  >;
};

function buildZeroBalances(resources: readonly Resource[]) {
  return Object.fromEntries(resources.map(resource => [resource, 0])) as Record<Resource, number>;
}

function headquartersCityId(
  country: Country,
  scenario?: ScenarioFile
) {
  return (
    (scenario ? resolveScenarioHeadquartersCity(scenario, country.country.id) : undefined) ??
    country.cities.find(city => city.capital)?.id
  );
}

function toCityResourceInputs(
  country: Country,
  countryId: string,
  city: Country["cities"][number],
  resource: Resource,
  buildingsFile: BuildingsFile,
  opts?: CountryResourceBalanceOptions
): CityResourceInputs {
  return {
    resource,
    startPop: city.population as StartingPopulation,
    moraleParams: {
      S: STARTING_MORALE_DAY1,
      T: HOMELAND_TARGET_MORALE,
      N:
        headquartersCityId(country, opts?.scenario) === city.id
          ? buildingMoraleBonusN(buildingsFile, "relocate_headquarters", 1)
          : 0,
      D: DEFAULT_MORALE_DECAY_D,
    },
    ecoInfraMultiplier: opts?.cityDefaults?.ecoInfraMultiplier,
    hiddenMultiplierOverride: opts?.cityDefaults?.hiddenMultiplierOverride,
    populationMode: opts?.cityDefaults?.populationMode,
    populationOpts: opts?.cityDefaults?.populationOpts,
    multiplierByPop: opts?.cityDefaults?.multiplierByPop,
    cityStatus:
      opts?.scenario
        ? resolveScenarioCityStatus(opts.scenario, countryId, city.id)
        : opts?.cityDefaults?.cityStatus,
    buildingEffects: getEconomicBuildingEffectsForLevels(buildingsFile, {
      air_base: city.starting.air_base,
      arms_industry: city.starting.arms_industry,
      naval_base: city.starting.naval_base,
    }),
  };
}

export function buildCountryHourlyResourceBalanceTable(
  country: Country,
  days: number,
  gameSpeed: "1x" | "4x" | "10x",
  opts: CountryResourceBalanceOptions
): CountryHourlyBalanceTable {
  if (!Number.isFinite(days) || days < 1) {
    throw new Error(`days must be >= 1, got ${days}`);
  }

  const resources = Array.from(
    new Set([
      "cash" as Resource,
      "manpower" as Resource,
      ...country.cities.map(city => city.resource as Resource),
      ...Object.keys(opts.startingBalances ?? {}).map(resource => resource as Resource),
    ])
  ).sort() as Resource[];
  const hourlyCount = days * 24;
  const productionByHour = Array.from({ length: hourlyCount }, () => buildZeroBalances(resources));
  const balances = buildZeroBalances(resources);
  const startAbsoluteHour = opts.startAbsoluteHour ?? 0;

  for (const resource of resources) {
    const startingBalance = opts.startingBalances?.[resource] ?? 0;
    if (!Number.isFinite(startingBalance)) {
      throw new Error(`starting balance for ${resource} must be finite, got ${startingBalance}`);
    }
    balances[resource] = Math.floor(startingBalance);
  }

  for (const city of country.cities) {
    const generatedResources = Array.from(
      new Set<Resource>([city.resource as Resource, "cash", "manpower"])
    );

    for (const resource of generatedResources) {
      const hourly = buildHourlyResourceTable(
        days,
        gameSpeed,
        toCityResourceInputs(country, country.country.id, city, resource, opts.buildingsFile, opts),
        {
          startAbsoluteHour: opts.startAbsoluteHour,
        }
      );
      for (const row of hourly.rows) {
        productionByHour[row.hour - 1][resource] += row.amount;
      }
    }
  }

  const rows: CountryHourlyBalanceRow[] = [];

  for (let index = 0; index < hourlyCount; index++) {
    const hour = index + 1;
    for (const resource of resources) {
      balances[resource] += productionByHour[index][resource];
    }

    rows.push({
      hour,
      day: Math.floor((startAbsoluteHour + index) / 24) + 1,
      hourOfDay: ((startAbsoluteHour + index) % 24) + 1,
      balances: { ...balances },
    });
  }

  return {
    rows,
    endingBalances: { ...balances },
  };
}
