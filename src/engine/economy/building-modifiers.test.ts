import test from "node:test";
import assert from "node:assert/strict";

import {
  getEconomicBuildingEffectsForLevels,
  interpolateEconomicBuildingEffects,
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

test("shared building modifiers add air, naval, and arms production bonuses together", () => {
  const buildings = buildTestBuildings();
  const effects = getEconomicBuildingEffectsForLevels(buildings, {
    air_base: 1,
    arms_industry: 1,
    naval_base: 2,
  });

  assert.equal(effects.productionBonusPct, 0.16);
});

test("shared building modifiers expose recruiting office manpower bonuses", () => {
  const buildings = buildTestBuildings();
  const effects = getEconomicBuildingEffectsForLevels(buildings, {
    recruiting_office: 1,
  });

  assert.equal(effects.manpowerBonusPct, 0.5);
  assert.equal(effects.flatBonuses.manpower, 50);
});

test("interpolated economic building effects scale linearly during construction", () => {
  const buildings = buildTestBuildings();
  const effects = interpolateEconomicBuildingEffects(buildings, {
    buildingId: "naval_base",
    fromLevel: 2,
    toLevel: 3,
    progressRatio: 0.5,
  });

  assert.equal(Number(effects.productionBonusPct.toFixed(3)), 0.075);
});
