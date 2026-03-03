import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import {
  DEFAULT_MORALE_DECAY_D,
  HOMELAND_TARGET_MORALE,
  STARTING_MORALE_DAY1,
  type Resource,
  type StartingPopulation,
} from "../../core/constants.js";
import {
  buildHourlyResourceTable,
  type CityResourceInputs,
} from "./resource-table.js";
import { buildCountrySchema, type Country } from "../../validation/countrySchema.js";
import { loadEnumerations, projectRoot } from "../../validation/enums.js";
import { getScenarioCountryPath } from "../../validation/scenarioPaths.js";

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
  cityDefaults?: Pick<
    CityResourceInputs,
    "ecoInfraMultiplier" | "hiddenMultiplierOverride" | "populationMode" | "populationOpts" | "multiplierByPop"
  >;
};

function buildZeroBalances(resources: readonly Resource[]) {
  return Object.fromEntries(resources.map(resource => [resource, 0])) as Record<Resource, number>;
}

function toCityResourceInputs(
  city: Country["cities"][number],
  resource: Resource,
  opts?: CountryResourceBalanceOptions
): CityResourceInputs {
  return {
    resource,
    startPop: city.population as StartingPopulation,
    moraleParams: {
      S: STARTING_MORALE_DAY1,
      T: HOMELAND_TARGET_MORALE,
      N: 0,
      D: DEFAULT_MORALE_DECAY_D,
    },
    ecoInfraMultiplier: opts?.cityDefaults?.ecoInfraMultiplier,
    hiddenMultiplierOverride: opts?.cityDefaults?.hiddenMultiplierOverride,
    populationMode: opts?.cityDefaults?.populationMode,
    populationOpts: opts?.cityDefaults?.populationOpts,
    multiplierByPop: opts?.cityDefaults?.multiplierByPop,
  };
}

export function loadCountry(countryPath: string): Country {
  const root = projectRoot();
  const enums = loadEnumerations(path.join(root, "data", "enums.yml"));
  const schema = buildCountrySchema(enums);
  const raw = fs.readFileSync(countryPath, "utf8");
  const parsed = YAML.parse(raw);
  return schema.parse(parsed);
}

export function loadScenarioCountry(scenarioId: string, countryId: string): Country {
  return loadCountry(getScenarioCountryPath(scenarioId, countryId));
}

export function buildCountryHourlyResourceBalanceTable(
  country: Country,
  days: number,
  gameSpeed: "1x" | "4x" | "10x",
  opts?: CountryResourceBalanceOptions
): CountryHourlyBalanceTable {
  if (!Number.isFinite(days) || days < 1) {
    throw new Error(`days must be >= 1, got ${days}`);
  }

  const resources = Array.from(
    new Set([
      "cash" as Resource,
      "manpower" as Resource,
      ...country.cities.map(city => city.resource as Resource),
      ...Object.keys(opts?.startingBalances ?? {}).map(resource => resource as Resource),
    ])
  ).sort() as Resource[];
  const hourlyCount = days * 24;
  const productionByHour = Array.from({ length: hourlyCount }, () => buildZeroBalances(resources));
  const balances = buildZeroBalances(resources);
  const startAbsoluteHour = opts?.startAbsoluteHour ?? 0;

  for (const resource of resources) {
    const startingBalance = opts?.startingBalances?.[resource] ?? 0;
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
      const hourly = buildHourlyResourceTable(days, gameSpeed, toCityResourceInputs(city, resource, opts), {
        startAbsoluteHour: opts?.startAbsoluteHour,
      });
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
