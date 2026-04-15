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
const turkey = loadScenarioCountry(scenarioId, "turkey");

const hoursToSimulate = 28 * 24;
const daysToSimulate = Math.ceil(hoursToSimulate / 24);
const simulationStartAbsoluteHour = scenarioStartAbsoluteHour(scenario);

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

const homelandTable = buildCountryHourlyResourceBalanceTable(
  turkey,
  daysToSimulate,
  scenario.speed,
  {
    buildingsFile,
    scenario,
    startAbsoluteHour: simulationStartAbsoluteHour,
  }
);

const hourlyRows = hourlyProductionDeltas(
  homelandTable,
  simulationStartAbsoluteHour
).slice(0, hoursToSimulate).map(row => ({
  absoluteHour: row.absoluteHour,
  mapDay: mapDayForAbsoluteHour(row.absoluteHour),
  hourOfDay: hourOfMapDay(row.absoluteHour),
  production: row.production,
}));

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

console.log("Elite WW3 Turkey homeland economy smoke");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(
  `Scenario start: day ${scenario.start.day}, hour ${scenario.start.hour}, t0=${simulationStartAbsoluteHour}`
);
console.log("Assumptions:");
console.log("- Turkey economy only");
console.log("- homeland cities and provinces only");
console.log("- no Turkey build queue");
console.log("- no unit research or mobilisation");
console.log("- no starting balances applied");
console.log("Daily homeland production and rolling balances:");
console.table(dailyRows);
console.log("Ending homeland-only balances:");
console.table([endingBalances]);
