import fs from "node:fs";
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

function parsePositiveInt(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCountryList(value: string | undefined, fallback: string[]) {
  if (!value?.trim()) return fallback;
  return value
    .split(",")
    .map(part => part.trim().toLowerCase())
    .filter(Boolean);
}

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

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function htmlTable(rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return "<p><em>None</em></p>";
  const headers = Array.from(
    rows.reduce((set, row) => {
      for (const key of Object.keys(row)) set.add(key);
      return set;
    }, new Set<string>())
  );
  const head = `<tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join("")}</tr>`;
  const body = rows
    .map(row =>
      `<tr>${headers.map(header => `<td>${escapeHtml(row[header]).replaceAll("\n", "<br>")}</td>`).join("")}</tr>`
    )
    .join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

const scenarioId = process.env.WROE_SCENARIO?.trim() || "ww3_2026";
const homelandCountries = parseCountryList(process.env.WROE_HOMELAND_COUNTRIES, [
  "france",
  "germany",
  "iran",
  "spain",
  "sweden",
]);
const daysToSimulate = parsePositiveInt(process.env.WROE_DAYS, 28);
const captureStartDay = parsePositiveInt(process.env.WROE_CAPTURE_DAY, 10);
const outputFilePath = path.resolve(
  process.env.WROE_OUTPUT_FILE?.trim() || "tmp/ww3-2026-remaining-occupied-economy.html"
);

const scenario = loadScenarioFile(scenarioId);
const buildingsFile = loadBuildingsFile(path.resolve("data/buildings.yml"));
const simulationStartAbsoluteHour = scenarioStartAbsoluteHour(scenario);
const occupationStartAbsoluteHour = ((captureStartDay - 1) * 24) + 0;
const hoursToSimulate = daysToSimulate * 24;
const countryDirectory = path.resolve(`data/scenarios/${scenarioId}/countries`);
const allCountryIds = fs
  .readdirSync(countryDirectory)
  .filter(name => name.endsWith(".yml"))
  .map(name => name.replace(/\.yml$/, ""))
  .sort();
const occupiedCountryIds = allCountryIds.filter(countryId => !homelandCountries.includes(countryId));

const perCountry = occupiedCountryIds.map(countryId => {
  const country = loadScenarioCountry(scenarioId, countryId);
  const occupiedScenario = {
    ...scenario,
    city_statuses: {
      ...(scenario.city_statuses ?? {}),
      [countryId]: Object.fromEntries(country.cities.map(city => [city.id, "occupied" as const])),
    },
  };
  const occupiedTable = buildCountryHourlyResourceBalanceTable(
    country,
    daysToSimulate,
    scenario.speed,
    {
      buildingsFile,
      scenario: occupiedScenario,
      startAbsoluteHour: simulationStartAbsoluteHour,
      provinceDefaults: {
        cityStatus: "occupied",
      },
    }
  );
  const hourly = hourlyProductionDeltas(
    occupiedTable,
    simulationStartAbsoluteHour
  ).slice(0, hoursToSimulate);
  const includedHourly = hourly.map(row => {
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
  const endingBalances = includedHourly.reduce((balances, row) => {
    for (const resource of RESOURCE_KEYS) {
      balances[resource] += row.production[resource];
    }
    return balances;
  }, zeroAmounts());

  return {
    countryId,
    countryName: country.country.name,
    hourly: includedHourly,
    endingBalances,
  };
});

const combinedHourlyRows = Array.from({ length: hoursToSimulate }, (_, index) => {
  const absoluteHour = simulationStartAbsoluteHour + index;
  const combined = zeroAmounts();

  for (const country of perCountry) {
    const row = country.hourly[index];
    if (!row) continue;
    for (const resource of RESOURCE_KEYS) {
      combined[resource] += row.production[resource];
    }
  }

  return {
    absoluteHour,
    mapDay: mapDayForAbsoluteHour(absoluteHour),
    hourOfDay: hourOfMapDay(absoluteHour),
    occupiedIncluded: absoluteHour >= occupationStartAbsoluteHour,
    combined,
  };
});

const rollingRows = combinedHourlyRows.reduce<Array<{
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

const dailyRows = Array.from({ length: daysToSimulate + 1 }, (_, index) => {
  const mapDay = scenario.start.day + index;
  const dayHourly = combinedHourlyRows.filter(row => row.mapDay === mapDay);
  const production = dayHourly.reduce((acc, row) => {
    for (const resource of RESOURCE_KEYS) {
      acc[resource] += row.combined[resource];
    }
    return acc;
  }, zeroAmounts());
  const endOfDay = rollingRows.filter(row => row.mapDay === mapDay).at(-1);

  return {
    mapDay,
    hoursCounted: dayHourly.length,
    supplies: production.supplies,
    components: production.components,
    fuel: production.fuel,
    rares: production.rares,
    electronics: production.electronics,
    cash: production.cash,
    manpower: production.manpower,
    endSupplies: endOfDay?.balances.supplies ?? 0,
    endComponents: endOfDay?.balances.components ?? 0,
    endFuel: endOfDay?.balances.fuel ?? 0,
    endRares: endOfDay?.balances.rares ?? 0,
    endElectronics: endOfDay?.balances.electronics ?? 0,
    endCash: endOfDay?.balances.cash ?? 0,
    endManpower: endOfDay?.balances.manpower ?? 0,
  };
});

const countrySummaryRows = perCountry.map(country => ({
  country: country.countryName,
  supplies: country.endingBalances.supplies,
  components: country.endingBalances.components,
  fuel: country.endingBalances.fuel,
  rares: country.endingBalances.rares,
  electronics: country.endingBalances.electronics,
  cash: country.endingBalances.cash,
  manpower: country.endingBalances.manpower,
}));

const endingBalances = rollingRows.at(-1)?.balances ?? zeroAmounts();
const assumptionsRows = [{
  scenario: `${scenario.id} (${scenario.speed})`,
  homelandCountries: homelandCountries.join(", "),
  occupiedCountries: occupiedCountryIds.join(", "),
  daysToSimulate,
  captureStartDay,
  captureStartAbsoluteHour: occupationStartAbsoluteHour,
  scenarioStartDay: scenario.start.day,
  scenarioStartHour: scenario.start.hour,
  startingBalancesApplied: "no",
  buildQueuesApplied: "no",
  cityStatus: "occupied",
}];

const html = `<!doctype html><html><head><meta charset="utf-8"><title>WW3 2026 Remaining Occupied Economy</title><style>
body{font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.4;padding:24px;max-width:1800px;margin:0 auto}
table{border-collapse:collapse;width:100%;margin:12px 0 24px}
th,td{border:1px solid #d0d7de;padding:8px 10px;vertical-align:top;text-align:left}
th{background:#f6f8fa}
h1,h2{margin:20px 0 8px}
</style></head><body>
<h1>WW3 2026 Remaining Occupied Economy</h1>
${htmlTable(assumptionsRows)}
<h2>Per-Country 28-Day Occupied Totals</h2>
${htmlTable(countrySummaryRows)}
<h2>Combined Daily Occupied Production</h2>
${htmlTable(dailyRows)}
<h2>Combined Ending Balances</h2>
${htmlTable([endingBalances])}
</body></html>`;

fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
fs.writeFileSync(outputFilePath, html, "utf8");

console.log("WW3 2026 remaining occupied economy smoke");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(`Homeland countries: ${homelandCountries.join(", ")}`);
console.log(`Occupied from start of map day ${captureStartDay}`);
console.log(`Occupied countries: ${occupiedCountryIds.join(", ")}`);
console.log("Per-country occupied totals:");
console.table(countrySummaryRows);
console.log("Combined daily occupied production:");
console.table(dailyRows);
console.log("Combined ending occupied balances:");
console.table([endingBalances]);
console.error(`[ww3-2026-remaining-occupied-economy] html written to ${outputFilePath}`);
