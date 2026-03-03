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
