import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { parseCountry, type Country } from "../../schemas/country-schema.js";
import { loadEnumerations } from "./load-enums.js";
import { getScenarioCountryPath } from "../paths.js";

export function loadCountry(countryPath: string): Country {
  const raw = fs.readFileSync(countryPath, "utf8");
  const parsed = YAML.parse(raw);
  const expectedCountryId = path.basename(countryPath, path.extname(countryPath));

  return parseCountry(parsed, loadEnumerations(), {
    source: countryPath,
    expectedCountryId,
  });
}

export function loadScenarioCountry(scenarioId: string, countryId: string): Country {
  return loadCountry(getScenarioCountryPath(scenarioId, countryId));
}
