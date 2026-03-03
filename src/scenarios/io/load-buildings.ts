import fs from "node:fs";
import YAML from "yaml";

import { parseBuildingsFile, type BuildingsFile } from "../../schemas/building-schema.js";
import { getBuildingsPath } from "../paths.js";

export function loadBuildingsFile(filePath = getBuildingsPath()): BuildingsFile {
  const raw = fs.readFileSync(filePath, "utf8");
  return parseBuildingsFile(YAML.parse(raw), filePath);
}
