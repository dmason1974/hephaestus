import path from "node:path";
import { fileURLToPath } from "node:url";

export function projectRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, "..", "..");
}

export function getEnumsPath() {
  return path.join(projectRoot(), "data", "enums.yml");
}

export function getBuildingsPath() {
  return path.join(projectRoot(), "data", "buildings.yml");
}

export function getScenarioPath(scenarioId: string) {
  return path.join(projectRoot(), "data", "scenarios", scenarioId, "scenario.yml");
}

export function getScenarioCountriesDir(scenarioId: string) {
  return path.join(projectRoot(), "data", "scenarios", scenarioId, "countries");
}

export function getScenarioCountryPath(scenarioId: string, countryId: string) {
  return path.join(getScenarioCountriesDir(scenarioId), `${countryId}.yml`);
}

export function getScenarioPlansDir(scenarioId: string) {
  return path.join(projectRoot(), "data", "scenarios", scenarioId, "plans");
}

export function getScenarioPlanPath(scenarioId: string, planId: string) {
  return path.join(getScenarioPlansDir(scenarioId), `${planId}.yml`);
}

export function getScenarioUnitsDir(scenarioId: string) {
  return path.join(projectRoot(), "data", "scenarios", scenarioId, "units");
}

export function getScenarioTierUnitsDir(scenarioId: string): string | null {
  const slashIndex = scenarioId.lastIndexOf("/");
  if (slashIndex === -1) return null;
  const tier = scenarioId.slice(0, slashIndex);
  return path.join(projectRoot(), "data", "scenarios", tier, "units");
}
