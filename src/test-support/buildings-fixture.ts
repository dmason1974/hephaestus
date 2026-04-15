import path from "node:path";

import { loadBuildingsFile } from "../scenarios/io/load-buildings.js";

export function buildTestBuildings() {
  return loadBuildingsFile(path.resolve("data/test-fixtures/buildings.test.yml"));
}
