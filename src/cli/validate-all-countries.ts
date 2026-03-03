import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getScenarioCountriesDir } from "../scenarios/paths.js";
import { validateCountryFile } from "./validate-country.js";

export function validateScenarioCountries(scenarioId: string): void {
  const dir = getScenarioCountriesDir(scenarioId);
  const files = fs
    .readdirSync(dir)
    .filter(file => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort();

  if (files.length === 0) {
    throw new Error(`No country files found in ${dir}`);
  }

  for (const file of files) {
    validateCountryFile(path.join(dir, file));
  }
}

const isCli =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isCli) {
  const scenarioId = process.argv[2];

  if (!scenarioId) {
    console.error("Usage: npm run validate:countries -- <scenarioId>");
    process.exit(2);
  }

  try {
    validateScenarioCountries(scenarioId);
    console.log(`✅ Validated scenario country file(s) for ${scenarioId}`);
  } catch (error) {
    console.error(`❌ ${String(error)}\n`);
    process.exit(1);
  }
}
