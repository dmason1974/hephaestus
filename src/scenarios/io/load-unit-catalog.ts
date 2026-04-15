import fs from "node:fs";

import YAML from "yaml";

import { parseUnitCatalog, type UnitCatalog } from "../../schemas/unit-schema.js";
import { loadEnumerations } from "./load-enums.js";

export function loadUnitCatalog(filePath: string): UnitCatalog {
  const raw = fs.readFileSync(filePath, "utf8");
  const enums = loadEnumerations();
  return parseUnitCatalog(YAML.parse(raw), enums, filePath);
}
