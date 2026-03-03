import fs from "node:fs";
import YAML from "yaml";

import { parseScenarioFile, type ScenarioFile } from "../../schemas/scenario-schema.js";
import { getScenarioPath } from "../paths.js";

export function loadScenarioFile(scenarioId: string): ScenarioFile {
  const scenarioPath = getScenarioPath(scenarioId);
  const raw = fs.readFileSync(scenarioPath, "utf8");
  return parseScenarioFile(YAML.parse(raw), scenarioPath);
}
