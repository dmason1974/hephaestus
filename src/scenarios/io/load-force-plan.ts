import fs from "node:fs";

import YAML from "yaml";

import { parseForcePlanFile, type ForcePlanFile } from "../../schemas/force-plan-schema.js";
import { getScenarioPlanPath } from "../paths.js";

export function loadForcePlanFile(filePath: string): ForcePlanFile {
  const raw = fs.readFileSync(filePath, "utf8");
  return parseForcePlanFile(YAML.parse(raw), filePath);
}

export function loadScenarioForcePlan(scenarioId: string, planId: string): ForcePlanFile {
  return loadForcePlanFile(getScenarioPlanPath(scenarioId, planId));
}
