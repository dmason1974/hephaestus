import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCountryFile } from "./validateCountryFile.js";
import { getScenarioCountriesDir } from "./scenarioPaths.js";

export function validateScenarioCountries(scenarioId: string): void {
  const dir = getScenarioCountriesDir(scenarioId);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();

  if (files.length === 0) {
    throw new Error(`No country files found in ${dir}`);
  }

  for (const f of files) {
    const full = path.join(dir, f);
    validateCountryFile(full);
  }
}

const isCli =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isCli) {
  const scenarioId = process.argv[2];

  if (!scenarioId) {
    console.error(
      "Usage: npm run validate:countries -- <scenarioId>"
    );
    process.exit(2);
  }

  try {
    validateScenarioCountries(scenarioId);
    console.log(`✅ Validated scenario country file(s) for ${scenarioId}`);
  } catch (e) {
    console.error(`❌ ${String(e)}\n`);
    process.exit(1);
  }
}
