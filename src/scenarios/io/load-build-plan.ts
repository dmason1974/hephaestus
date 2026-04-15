import fs from "node:fs";

import YAML from "yaml";

import { parseBuildPlanFile, type BuildPlanFile } from "../../schemas/build-plan-schema.js";

export function loadBuildPlanFile(filePath: string): BuildPlanFile {
  const raw = fs.readFileSync(filePath, "utf8");
  return parseBuildPlanFile(YAML.parse(raw), filePath);
}
