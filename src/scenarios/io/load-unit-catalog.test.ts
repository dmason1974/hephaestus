import assert from "node:assert/strict";
import test from "node:test";

import { getScenarioTierUnitsDir } from "../paths.js";
import {
  loadMergedUnitCatalogForScenario,
  resolveUnitCatalogPathForScenario,
  resolveUnitCatalogDirForScenario,
} from "./load-unit-catalog.js";

test("scenario unit catalog resolution falls back to the tier units directory when no scenario-local override exists", () => {
  assert.equal(resolveUnitCatalogDirForScenario("elite/ww3"), getScenarioTierUnitsDir("elite/ww3"));
});

test("scenario unit catalog resolution falls back to the tier units directory for standard/ww3", () => {
  assert.equal(resolveUnitCatalogDirForScenario("standard/ww3"), getScenarioTierUnitsDir("standard/ww3"));
});

test("scenario-local unit catalogs load successfully for standard/ww3", () => {
  const catalog = loadMergedUnitCatalogForScenario("standard/ww3");

  assert.ok(catalog.units.air_superiority_fighter);
  assert.ok(catalog.units.mobile_anti_air_vehicle);
});

test("scenario unit catalog file resolution points at the tier units directory when no scenario-local override exists", () => {
  assert.equal(
    resolveUnitCatalogPathForScenario("standard/ww3", "fighter_units.yml"),
    `${getScenarioTierUnitsDir("standard/ww3")}/fighter_units.yml`
  );
});
