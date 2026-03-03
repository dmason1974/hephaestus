import test from "node:test";
import assert from "node:assert/strict";

import {
  getEconomicBuildingEffectsForLevels,
  undergroundBunkerMoraleBonusN,
} from "./building-modifiers.js";
import { buildTestBuildings } from "../../test-support/buildings-fixture.js";

test("shared building modifiers expose underground bunker morale bonus", () => {
  const buildings = buildTestBuildings();

  assert.equal(undergroundBunkerMoraleBonusN(buildings, 0), 0);
  assert.equal(undergroundBunkerMoraleBonusN(buildings, 1), 5);
  assert.equal(undergroundBunkerMoraleBonusN(buildings, 5), 50);
  assert.equal(
    getEconomicBuildingEffectsForLevels(buildings, { underground_bunkers: 1 }).moraleBonusN,
    5
  );
});
