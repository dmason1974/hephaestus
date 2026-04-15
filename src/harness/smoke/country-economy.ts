import fs from "node:fs";
import path from "node:path";

import type { CityStatus } from "../../core/constants.js";
import { buildCountryHourlyResourceBalanceTable } from "../../engine/reporting/country-resource-balance.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";

function parsePositiveInt(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCityStatus(value: string | undefined): CityStatus {
  return value === "occupied" || value === "annexed" ? value : "homeland";
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
  const body = rows.map(row =>
    `<tr>${headers.map(header => `<td>${escapeHtml(row[header]).replaceAll("\n", "<br>")}</td>`).join("")}</tr>`
  ).join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

const scenarioId = process.env.CE_SCENARIO?.trim() || "elite_ava_feb_2026";
const countryId = process.env.CE_COUNTRY?.trim() || "ukraine";
const daysToSimulate = parsePositiveInt(process.env.CE_DAYS, 28);
const cityStatus = parseCityStatus(process.env.CE_CITY_STATUS);
const outputFilePath = path.resolve(
  process.env.CE_OUTPUT_FILE?.trim() || "tmp/country-economy-output.html"
);

const scenario = loadScenarioFile(scenarioId);
const country = loadScenarioCountry(scenarioId, countryId);
const buildings = loadBuildingsFile(path.resolve("data/buildings.yml"));

const balanceTable = buildCountryHourlyResourceBalanceTable(
  country,
  daysToSimulate,
  scenario.speed,
  {
    buildingsFile: buildings,
    scenario,
    startingBalances: scenario.starting_balance,
    cityDefaults: { cityStatus },
    provinceDefaults: { cityStatus },
  }
);

const dailyRows = Array.from({ length: daysToSimulate }, (_, index) => {
  const start = index * 24;
  const end = Math.min(balanceTable.rows.length, (index + 1) * 24);
  const dayRows = balanceTable.rows.slice(start, end);
  const endRow = dayRows[dayRows.length - 1];
  return {
    day: index + 1,
    end_supplies: endRow?.balances.supplies ?? 0,
    end_components: endRow?.balances.components ?? 0,
    end_fuel: endRow?.balances.fuel ?? 0,
    end_rares: endRow?.balances.rares ?? 0,
    end_electronics: endRow?.balances.electronics ?? 0,
    end_cash: endRow?.balances.cash ?? 0,
    end_manpower: endRow?.balances.manpower ?? 0,
    min_supplies: Math.min(...dayRows.map(row => row.balances.supplies)),
    min_components: Math.min(...dayRows.map(row => row.balances.components)),
    min_fuel: Math.min(...dayRows.map(row => row.balances.fuel)),
    min_rares: Math.min(...dayRows.map(row => row.balances.rares)),
    min_electronics: Math.min(...dayRows.map(row => row.balances.electronics)),
    min_cash: Math.min(...dayRows.map(row => row.balances.cash)),
    min_manpower: Math.min(...dayRows.map(row => row.balances.manpower)),
  };
});

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Country Economy</title><style>
body{font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.4;padding:24px;max-width:1600px;margin:0 auto}
table{border-collapse:collapse;width:100%;margin:12px 0 24px}
th,td{border:1px solid #d0d7de;padding:8px 10px;vertical-align:top;text-align:left}
th{background:#f6f8fa}
h1,h2{margin:20px 0 8px}
</style></head><body>
<h1>Country Economy</h1>
${htmlTable([{
  scenario: `${scenario.id} (${scenario.speed})`,
  country: country.country.name,
  cityStatus,
  windowDays: daysToSimulate,
}])}
<h2>Daily Country Balances</h2>
${htmlTable(dailyRows)}
</body></html>`;

fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
fs.writeFileSync(outputFilePath, html, "utf8");

console.log("Country economy");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(`Country: ${country.country.name}`);
console.log(`City status: ${cityStatus}`);
console.log(`Window: ${daysToSimulate} days`);
console.table(dailyRows);
console.error(`[country-economy] html written to ${outputFilePath}`);
