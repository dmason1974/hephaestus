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
const greece = loadScenarioCountry(scenarioId, "greece");

const hoursToSimulate = 28 * 24;
const daysToSimulate = Math.ceil(hoursToSimulate / 24);
const simulationStartAbsoluteHour = scenarioStartAbsoluteHour(scenario);
const occupationStartAbsoluteHour = ((3 - 1) * 24) + 0;

const occupiedGreeceScenario = {
  ...scenario,
  city_statuses: {
    ...(scenario.city_statuses ?? {}),
    greece: Object.fromEntries(greece.cities.map(city => [city.id, "occupied" as const])),
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

function hourlyProductionDeltas(
  table: ReturnType<typeof buildCountryHourlyResourceBalanceTable>,
  absoluteHourOffset: number
) {
  return table.rows.map((row, index) => {
    const previous = index === 0 ? null : table.rows[index - 1]?.balances;
    const production = Object.fromEntries(
      RESOURCE_KEYS.map(resource => [
        resource,
        previous ? row.balances[resource] - previous[resource] : row.balances[resource],
      ])
    ) as Record<Resource, number>;

    return {
      absoluteHour: absoluteHourOffset + index,
      production,
    };
  });
}

const occupiedTable = buildCountryHourlyResourceBalanceTable(
  greece,
  daysToSimulate,
  scenario.speed,
  {
    buildingsFile,
    scenario: occupiedGreeceScenario,
    startAbsoluteHour: simulationStartAbsoluteHour,
    provinceDefaults: {
      cityStatus: "occupied",
    },
  }
);

const hourlyProduction = hourlyProductionDeltas(
  occupiedTable,
  simulationStartAbsoluteHour
).slice(0, hoursToSimulate);

const hourlyRows = hourlyProduction.map(row => {
  const included = row.absoluteHour >= occupationStartAbsoluteHour;
  const production = zeroAmounts();

  for (const resource of RESOURCE_KEYS) {
    production[resource] = included ? row.production[resource] : 0;
  }

  return {
    absoluteHour: row.absoluteHour,
    mapDay: mapDayForAbsoluteHour(row.absoluteHour),
    hourOfDay: hourOfMapDay(row.absoluteHour),
    included,
    production,
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
    balances[resource] = previous[resource] + row.production[resource];
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
  const production = dayHourly.reduce((acc, row) => {
    for (const resource of RESOURCE_KEYS) {
      acc[resource] += row.production[resource];
    }
    return acc;
  }, zeroAmounts());
  const endOfDay = rollingRows.filter(row => row.mapDay === mapDay).at(-1);

  return {
    mapDay,
    hoursCounted: dayHourly.length,
    ...production,
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

console.log("Elite WW3 Greece occupied economy smoke");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(
  `Scenario start: day ${scenario.start.day}, hour ${scenario.start.hour}, t0=${simulationStartAbsoluteHour}`
);
console.log("Assumptions:");
console.log("- Greece economy only");
console.log("- all Greece cities and provinces are treated as occupied");
console.log("- occupied production is counted from start of map day 3");
console.log("- no Greece build queue");
console.log("- no starting balances applied");
console.log("Daily occupied production and rolling balances:");
console.table(dailyRows);
console.log("Ending occupied-only balances:");
console.table([endingBalances]);
