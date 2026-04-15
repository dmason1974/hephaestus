import path from "node:path";

import type { Resource } from "../../core/constants.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import { buildCountryHourlyResourceBalanceTable } from "../../engine/reporting/country-resource-balance.js";
import { hourOfMapDay, mapDayForAbsoluteHour } from "../../engine/reporting/scenario-reporting.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";

const RESOURCE_KEYS: Resource[] = [
  "supplies",
  "components",
  "fuel",
  "rares",
  "electronics",
  "cash",
  "manpower",
];

const scenarioId = "elite_ww3_2026";
const scenario = loadScenarioFile(scenarioId);
const buildingsFile = loadBuildingsFile(path.resolve("data/buildings.yml"));
const indonesia = loadScenarioCountry(scenarioId, "indonesia");
const philippines = loadScenarioCountry(scenarioId, "philippines");

const hoursToSimulate = 28 * 24;
const daysToSimulate = Math.ceil(hoursToSimulate / 24);
const simulationStartAbsoluteHour = scenarioStartAbsoluteHour(scenario);
const occupationStartAbsoluteHour = ((4 - 1) * 24) + 0;

const occupiedPhilippinesScenario = {
  ...scenario,
  city_statuses: {
    ...(scenario.city_statuses ?? {}),
    philippines: Object.fromEntries(
      philippines.cities.map(city => [city.id, "occupied" as const])
    ),
  },
};

function zeroAmounts() {
  return {
    supplies: 0,
    components: 0,
    fuel: 0,
    rares: 0,
    electronics: 0,
    cash: 0,
    manpower: 0,
  } satisfies Record<Resource, number>;
}

function amountAt(
  balances: Partial<Record<Resource, number>> | undefined,
  resource: Resource
) {
  const value = balances?.[resource];
  return Number.isFinite(value) ? value : 0;
}

function hourlyProductionDeltas(
  table: ReturnType<typeof buildCountryHourlyResourceBalanceTable>,
  absoluteHourOffset: number
) {
  return table.rows.map((row, index) => {
    const previous = index === 0 ? null : table.rows[index - 1]?.balances;
    const production = Object.fromEntries(
      RESOURCE_KEYS.map(resource => [
        resource,
        previous
          ? amountAt(row.balances, resource) - amountAt(previous, resource)
          : amountAt(row.balances, resource),
      ])
    ) as Record<Resource, number>;

    return {
      absoluteHour: absoluteHourOffset + index,
      production,
    };
  });
}

const homelandTable = buildCountryHourlyResourceBalanceTable(
  indonesia,
  daysToSimulate,
  scenario.speed,
  {
    buildingsFile,
    scenario,
    startAbsoluteHour: simulationStartAbsoluteHour,
  }
);

const occupiedTable = buildCountryHourlyResourceBalanceTable(
  philippines,
  daysToSimulate,
  scenario.speed,
  {
    buildingsFile,
    scenario: occupiedPhilippinesScenario,
    startAbsoluteHour: simulationStartAbsoluteHour,
    provinceDefaults: {
      cityStatus: "occupied",
    },
  }
);

const indonesiaHourly = hourlyProductionDeltas(
  homelandTable,
  simulationStartAbsoluteHour
).slice(0, hoursToSimulate);

const philippinesHourly = hourlyProductionDeltas(
  occupiedTable,
  simulationStartAbsoluteHour
).slice(0, hoursToSimulate);

const hourlyRows = indonesiaHourly.map((row, index) => {
  const occupiedProduction = philippinesHourly[index]?.production ?? zeroAmounts();
  const occupiedIncluded = row.absoluteHour >= occupationStartAbsoluteHour;
  const combined = zeroAmounts();

  for (const resource of RESOURCE_KEYS) {
    combined[resource] =
      row.production[resource] + (occupiedIncluded ? occupiedProduction[resource] : 0);
  }

  return {
    absoluteHour: row.absoluteHour,
    mapDay: mapDayForAbsoluteHour(row.absoluteHour),
    hourOfDay: hourOfMapDay(row.absoluteHour),
    occupiedIncluded,
    indonesia: row.production,
    philippinesOccupied: occupiedIncluded ? occupiedProduction : zeroAmounts(),
    combined,
  };
});

const rollingRows = hourlyRows.reduce<Array<{
  absoluteHour: number;
  mapDay: number;
  hourOfDay: number;
  balances: Record<Resource, number>;
}>>((rows, row) => {
  const previous = rows.at(-1)?.balances ?? zeroAmounts();
  const balances = zeroAmounts();

  for (const resource of RESOURCE_KEYS) {
    balances[resource] = previous[resource] + row.combined[resource];
  }

  rows.push({
    absoluteHour: row.absoluteHour,
    mapDay: row.mapDay,
    hourOfDay: row.hourOfDay,
    balances,
  });

  return rows;
}, []);

const dailyRows = Array.from({ length: 29 }, (_, index) => {
  const mapDay = scenario.start.day + index;
  const dayHourly = hourlyRows.filter(row => row.mapDay === mapDay);

  const combinedProduction = dayHourly.reduce((acc, row) => {
    for (const resource of RESOURCE_KEYS) {
      acc[resource] += row.combined[resource];
    }
    return acc;
  }, zeroAmounts());

  const endOfDay = rollingRows.filter(row => row.mapDay === mapDay).at(-1);

  return {
    mapDay,
    hoursCounted: dayHourly.length,
    supplies: combinedProduction.supplies,
    components: combinedProduction.components,
    fuel: combinedProduction.fuel,
    rares: combinedProduction.rares,
    electronics: combinedProduction.electronics,
    cash: combinedProduction.cash,
    manpower: combinedProduction.manpower,
    endSupplies: endOfDay?.balances.supplies ?? 0,
    endComponents: endOfDay?.balances.components ?? 0,
    endFuel: endOfDay?.balances.fuel ?? 0,
    endRares: endOfDay?.balances.rares ?? 0,
    endElectronics: endOfDay?.balances.electronics ?? 0,
    endCash: endOfDay?.balances.cash ?? 0,
    endManpower: endOfDay?.balances.manpower ?? 0,
  };
});

const endingBalances = rollingRows.at(-1)?.balances ?? zeroAmounts();

console.log("Elite WW3 Indonesia homeland + Philippines occupied economy smoke");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(
  `Scenario start: day ${scenario.start.day}, hour ${scenario.start.hour}, t0=${simulationStartAbsoluteHour}`
);
console.log("Assumptions:");
console.log("- Indonesia contributes as homeland for the full 28-day window");
console.log("- Philippines contributes as occupied from start of map day 4");
console.log("- no Philippines contribution before map day 4");
console.log("- occupied status applies to Philippines cities and provinces");
console.log("- no build queue");
console.log("- no starting balances applied");
console.log("Daily production and rolling balances:");
console.table(dailyRows);
console.log("Ending combined balances:");
console.table([endingBalances]);
