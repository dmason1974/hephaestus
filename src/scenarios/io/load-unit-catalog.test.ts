import assert from "node:assert/strict";
import test from "node:test";

import { getDefaultUnitsDir, getScenarioUnitsDir } from "../paths.js";
import {
  loadMergedUnitCatalogForScenario,
  resolveUnitCatalogPathForScenario,
  resolveUnitCatalogDirForScenario,
} from "./load-unit-catalog.js";

test("scenario unit catalog resolution falls back to the shared units directory when no override exists", () => {
  assert.equal(resolveUnitCatalogDirForScenario("elite_ww3_2026"), getDefaultUnitsDir());
});

test("scenario unit catalog resolution prefers a scenario-local units directory when present", () => {
  assert.equal(resolveUnitCatalogDirForScenario("ww3_2026"), getScenarioUnitsDir("ww3_2026"));
});

test("scenario-local unit catalogs load successfully for ww3_2026", () => {
  const catalog = loadMergedUnitCatalogForScenario("ww3_2026");

  assert.ok(catalog.units.air_superiority_fighter);
  assert.ok(catalog.units.mobile_anti_air_vehicle);
  assert.ok(catalog.units.epic_airstrike_officer);
  assert.ok(catalog.units.elite_frigate);
});

test("scenario unit catalog file resolution points at the scenario-local override when present", () => {
  assert.equal(
    resolveUnitCatalogPathForScenario("ww3_2026", "fighter_units.yml"),
    `${getScenarioUnitsDir("ww3_2026")}/fighter_units.yml`
  );
});
