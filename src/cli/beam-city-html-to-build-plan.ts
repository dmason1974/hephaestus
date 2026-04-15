import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { parseBuildPlanFile } from "../schemas/build-plan-schema.js";
import { loadScenarioCountry } from "../scenarios/io/load-country.js";

type ParsedCitySection = {
  cityName: string;
  resource: string;
  timedOrderLines: string[];
};

function parseSummaryCell(html: string, header: string) {
  const tableMatch = html.match(/<h2>Summary<\/h2><table><thead><tr>(.*?)<\/tr><\/thead><tbody><tr>(.*?)<\/tr><\/tbody><\/table>/s);
  if (!tableMatch) return null;
  const [, headerRow = "", valueRow = ""] = tableMatch;
  const headers = Array.from(headerRow.matchAll(/<th>(.*?)<\/th>/g)).map(match => match[1] ?? "");
  const values = Array.from(valueRow.matchAll(/<td>(.*?)<\/td>/g)).map(match => (match[1] ?? "").replaceAll("<br>", "\n"));
  const index = headers.indexOf(header);
  return index >= 0 ? values[index] ?? null : null;
}

function stripTags(value: string) {
  return value.replace(/<[^>]+>/g, "").trim();
}

function parseCitySections(html: string): ParsedCitySection[] {
  const sections = html.split(/<h2>/).slice(2);
  const parsed: ParsedCitySection[] = [];

  for (const section of sections) {
    const cityNameMatch = section.match(/^([^<]+)<\/h2>/);
    const resourceMatch = section.match(/<th>resource<\/th>.*?<tbody><tr><td>(.*?)<\/td>/s);
    const bestTimedOrderMatch = section.match(/<h3>Best Timed Order<\/h3><ul>(.*?)<\/ul>/s);
    if (!cityNameMatch || !resourceMatch || !bestTimedOrderMatch) continue;

    const cityName = stripTags(cityNameMatch[1] ?? "");
    const resource = stripTags(resourceMatch[1] ?? "");
    const timedOrderLines = Array.from((bestTimedOrderMatch[1] ?? "").matchAll(/<li>(.*?)<\/li>/g))
      .map(match => stripTags(match[1] ?? ""));

    parsed.push({
      cityName,
      resource,
      timedOrderLines,
    });
  }

  return parsed;
}

function parseTimedOrderLine(line: string) {
  const match = line.match(/^\d+\.\s+([a-z_]+)\s+level\s+(\d+)\s+at\s+hour\s+(\d+)$/i);
  if (!match) {
    throw new Error(`Could not parse timed order line: ${line}`);
  }
  return {
    buildingId: match[1] ?? "",
    targetLevel: Number(match[2]),
    start_hour: Number(match[3]),
  };
}

const inputFilePath = path.resolve(process.env.BCH_INPUT_FILE?.trim() || "tmp/beam-city-output.html");
const rawHtml = fs.readFileSync(inputFilePath, "utf8");

const scenarioText = stripTags(parseSummaryCell(rawHtml, "scenario") ?? "");
const scenarioId = process.env.BCH_SCENARIO?.trim() || scenarioText.replace(/\s+\([^)]*\)\s*$/, "");
const countryName = stripTags(parseSummaryCell(rawHtml, "country") ?? "");
const countryId = process.env.BCH_COUNTRY?.trim() || countryName.toLowerCase().replace(/\s+/g, "_");
const outputFilePath = path.resolve(
  process.env.BCH_OUTPUT_FILE?.trim() || `data/scenarios/${scenarioId}/plans/${countryId}_beam_city_build.yml`
);

const country = loadScenarioCountry(scenarioId, countryId);
const cityByName = new Map(country.cities.map(city => [city.name, city]));

const cityPlans = parseCitySections(rawHtml).map(section => {
  const city = cityByName.get(section.cityName);
  if (!city) {
    throw new Error(`Could not match city "${section.cityName}" in scenario ${scenarioId}/${countryId}`);
  }

  return {
    cityId: city.id,
    cityName: city.name,
    resource: city.resource,
    build_order: section.timedOrderLines.map(parseTimedOrderLine),
  };
});

const plan = parseBuildPlanFile({
  schema_version: 1,
  domain: "build_plan",
  name: `${country.country.name} beam city build plan`,
  scenario: scenarioId,
  country: countryId,
  source_html: inputFilePath,
  city_plans: cityPlans,
}, outputFilePath);

fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
fs.writeFileSync(outputFilePath, YAML.stringify(plan), "utf8");

console.log(`Build plan written to ${outputFilePath}`);
