import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { parseUnitCatalog, type UnitCatalog } from "../../schemas/unit-schema.js";
import { getScenarioTierUnitsDir, getScenarioUnitsDir } from "../paths.js";
import { loadEnumerations } from "./load-enums.js";

export function loadUnitCatalog(filePath: string): UnitCatalog {
  const raw = fs.readFileSync(filePath, "utf8");
  const enums = loadEnumerations();
  return parseUnitCatalog(YAML.parse(raw), enums, filePath);
}

export function loadMergedUnitCatalogFromDir(dirPath: string): UnitCatalog {
  const catalogs = fs
    .readdirSync(dirPath)
    .filter(file => file.endsWith(".yml") || file.endsWith(".yml"))
    .sort()
    .map(file => loadUnitCatalog(path.join(dirPath, file)));

  return catalogs.reduce<UnitCatalog>(
    (merged, catalog) => ({
      ...merged,
      units: {
        ...merged.units,
        ...catalog.units,
      },
    }),
    { schema_version: 1, domain: "units", units: {} }
  );
}

export function resolveUnitCatalogDirForScenario(scenarioId: string): string {
  const scenarioUnitsDir = getScenarioUnitsDir(scenarioId);
  if (fs.existsSync(scenarioUnitsDir)) return scenarioUnitsDir;
  const tierUnitsDir = getScenarioTierUnitsDir(scenarioId);
  if (tierUnitsDir && fs.existsSync(tierUnitsDir)) return tierUnitsDir;
  throw new Error(`No units directory found for scenario "${scenarioId}"`);
}

export function resolveUnitCatalogPathForScenario(scenarioId: string, fileName: string): string {
  return path.join(resolveUnitCatalogDirForScenario(scenarioId), fileName);
}

export function loadScenarioUnitCatalog(scenarioId: string, fileName: string): UnitCatalog {
  return loadUnitCatalog(resolveUnitCatalogPathForScenario(scenarioId, fileName));
}

export function loadMergedUnitCatalogForScenario(scenarioId: string): UnitCatalog {
  return loadMergedUnitCatalogFromDir(resolveUnitCatalogDirForScenario(scenarioId));
}
