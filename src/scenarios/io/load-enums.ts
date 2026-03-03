import fs from "node:fs";
import YAML from "yaml";

import { parseEnumerations, type Enumerations } from "../../schemas/enums-schema.js";
import { getEnumsPath } from "../paths.js";

export function loadEnumerations(enumsPath = getEnumsPath()): Enumerations {
  const raw = fs.readFileSync(enumsPath, "utf8");
  return parseEnumerations(YAML.parse(raw), enumsPath);
}
