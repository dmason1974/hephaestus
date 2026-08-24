import test from "node:test";
import assert from "node:assert/strict";
import {
  baselineHomelandMoraleOnDay,
  homelandMoraleOnDayWithBunkers,
  moraleOnDay,
  moraleProductionMultiplier,
  occupiedMoraleOnDay,
} from "./morale.js";
import { buildTestBuildings } from "../../test-support/buildings-fixture.js";

function approxEqual(actual: number, expected: number, epsilon = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

test("moraleOnDay uses bunker bonus through N", () => {
  assert.equal(moraleOnDay(2, { S: 70, T: 90, N: 0, D: 8 }), 73);
  assert.equal(moraleOnDay(3, { S: 70, T: 90, N: 0, D: 8 }), 75);
  assert.equal(moraleOnDay(3, { S: 70, T: 90, N: 5, D: 8 }), 76);
});

test("homeland morale with bunkers keeps T fixed and applies bunker through N", () => {
  assert.equal(homelandMoraleOnDayWithBunkers(1, 0), baselineHomelandMoraleOnDay(1));
  const buildings = buildTestBuildings();
  assert.equal(homelandMoraleOnDayWithBunkers(2, 1, buildings), 72);
});

test("occupiedMoraleOnDay starts from the captured baseline, not the homeland one", () => {
  assert.equal(occupiedMoraleOnDay(1), 25);
  assert.notEqual(occupiedMoraleOnDay(1), baselineHomelandMoraleOnDay(1));
  assert.equal(occupiedMoraleOnDay(28), moraleOnDay(28, { S: 25, T: 92, N: 0, D: 13 }));
});

test("moraleProductionMultiplier remains the baseline coefficient mapping", () => {
  assert.equal(moraleProductionMultiplier(70), 0.81);
  assert.equal(moraleProductionMultiplier(82), 0.91);
});
