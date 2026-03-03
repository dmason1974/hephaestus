import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { validateBuildingsFile } from "../../../validation/buildingSchema.js";
import {
  getEconomicBuildingEffectsForLevels,
  undergroundBunkerMoraleBonusN,
} from "../building-modifiers.js";

test("shared building modifiers expose underground bunker morale bonus", () => {
  const buildings = validateBuildingsFile(path.resolve("data/buildings.yml"));

  assert.equal(undergroundBunkerMoraleBonusN(buildings, 0), 0);
  assert.equal(undergroundBunkerMoraleBonusN(buildings, 1), 5);
  assert.equal(undergroundBunkerMoraleBonusN(buildings, 5), 50);
  assert.equal(
    getEconomicBuildingEffectsForLevels(buildings, { underground_bunkers: 1 }).moraleBonusN,
    5
  );
});
