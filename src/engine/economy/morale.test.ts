import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import {
  baselineHomelandMoraleOnDay,
  homelandMoraleOnDayWithBunkers,
  moraleOnDay,
  moraleProductionMultiplier,
} from "./morale.js";

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
  const buildings = loadBuildingsFile(path.resolve("data/buildings.yml"));
  assert.equal(homelandMoraleOnDayWithBunkers(2, 1, buildings), 72);
});

test("moraleProductionMultiplier remains the baseline coefficient mapping", () => {
  approxEqual(moraleProductionMultiplier(70), ((70 * 0.8) / 100) + 0.25);
});
