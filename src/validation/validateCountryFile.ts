import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { fileURLToPath } from "node:url";

import { loadEnumerations, projectRoot } from "./enums.js";
import { buildCountrySchema } from "./countrySchema.js";

function countCapitals(cities: Array<{ capital: boolean }>): number {
  return cities.reduce((acc, c) => acc + (c.capital ? 1 : 0), 0);
}

function assertUniqueIds(ids: string[], label: string) {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  if (dupes.size > 0) {
    throw new Error(`Duplicate ${label}: ${Array.from(dupes).join(", ")}`);
  }
}

export function validateCountryFile(countryPath: string): void {
  const root = projectRoot();
  const enumsPath = path.join(root, "data", "enums.yml"); // <-- your actual filename

  const enums = loadEnumerations(enumsPath);
  const schema = buildCountrySchema(enums);

  const raw = fs.readFileSync(countryPath, "utf8");
  const parsed = YAML.parse(raw);

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid country YAML (${countryPath}):\n${result.error.toString()}`
    );
  }

  const country = result.data;

  // Rule: exactly one starting capital
  const capitals = countCapitals(country.cities);
  if (capitals !== 1) {
    throw new Error(
      `Invalid country YAML (${countryPath}): expected exactly 1 capital city, found ${capitals}`
    );
  }

  // Rule: unique city ids
  assertUniqueIds(country.cities.map((c) => c.id), "city.id");

  // Rule: optional but recommended - country.id matches filename
  const filename = path.basename(countryPath, path.extname(countryPath));
  if (filename !== country.country.id) {
    throw new Error(
      `Invalid country YAML (${countryPath}): filename '${filename}' must match country.id '${country.country.id}'`
    );
  }
}

// ---- CLI entrypoint (ESM-safe) ----
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
