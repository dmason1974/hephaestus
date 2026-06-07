import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { parseCoalitionForcePlan, type CoalitionForcePlan } from "../../schemas/coalition-force-plan-schema.js";

const DATA_ROOT = path.resolve("data");

export function loadCoalitionPlan(filePath: string): CoalitionForcePlan {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = YAML.parse(raw);
  return parseCoalitionForcePlan(parsed, filePath);
}

export function loadScenarioCoalitionPlan(scenarioId: string, planId: string): CoalitionForcePlan {
  const planPath = path.join(DATA_ROOT, "scenarios", scenarioId, "plans", `${planId}.yml`);
  return loadCoalitionPlan(planPath);
}
