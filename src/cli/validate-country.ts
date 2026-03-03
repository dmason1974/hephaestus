import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadCountry } from "../scenarios/io/load-country.js";

export function validateCountryFile(countryPath: string): void {
  loadCountry(countryPath);
}

const isCli =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isCli) {
  const arg = process.argv[2];
  if (!arg) {
    console.error(
      "Usage: npm run validate:country -- data/scenarios/<scenarioId>/countries/<country>.yml"
    );
    process.exit(2);
  }

  try {
    validateCountryFile(path.resolve(arg));
    console.log(`✅ Valid: ${arg}`);
  } catch (err) {
    console.error(`❌ ${String(err)}`);
    process.exit(1);
  }
}
