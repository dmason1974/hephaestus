import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { simulateBuildOrder, type CityState } from "./build-order-sim.js";
import { validateBuildingsFile } from "../../validation/buildingSchema.js";
import { bunkerMoraleBonusN } from "../../models/morale/bunker.js";
import {
  baselineHomelandMoraleOnDay,
  homelandMoraleOnDayWithBunkers,
} from "../../models/morale/morale-baseline.js";
import { moraleOnDay } from "../../models/morale/morale-model.js";
import { moraleProductionMultiplier } from "../../models/morale/morale-modifier.js";

const TEST_SCENARIO = {
  start: {
    day: 1,
    hour: 0,
  },
} as const;

function approxEqual(actual: number, expected: number, epsilon = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

function zeroBaseProduction() {
  return {
    supplies: 0,
    components: 0,
    fuel: 0,
    rares: 0,
    electronics: 0,
    cash: 0,
    manpower: 0,
  };
}

function baselineMoraleMultiplierForDay(day: number) {
  return moraleProductionMultiplier(baselineHomelandMoraleOnDay(day));
}

test("AI1 ramps from 1.0 to 1.10 and flat cash applies after completion hour", () => {
  const buildings = validateBuildingsFile(path.resolve("data/buildings.yml"));
  const city: CityState = {
    cityId: "alpha",
    baseHourlyProduction: { ...zeroBaseProduction(), cash: 1000 },
    buildings: { arms_industry: 0, underground_bunkers: 0 },
  };

  const result = simulateBuildOrder({
    cities: [city],
    buildOrder: [{ cityId: "alpha", buildingId: "arms_industry", targetLevel: 1, startHour: 0 }],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 12,
  });

  const hour0 = result.perHourPerCity.find(row => row.cityId === "alpha" && row.hour === 0);
  const hour9 = result.perHourPerCity.find(row => row.cityId === "alpha" && row.hour === 9);
  const hour10 = result.perHourPerCity.find(row => row.cityId === "alpha" && row.hour === 10);

  assert.ok(hour0);
  assert.ok(hour9);
  assert.ok(hour10);

  const day1MoraleMultiplier = baselineMoraleMultiplierForDay(1);
  approxEqual(hour0.effectiveBonusPct, 0.1 * (60 / 585));
  approxEqual(hour0.multiplier, day1MoraleMultiplier * (1 + (0.1 * (60 / 585))));
  assert.equal(hour0.flatCash, 0);

  approxEqual(hour9.effectiveBonusPct, 0.1);
  assert.equal(hour9.flatCash, 0);

  approxEqual(hour10.effectiveBonusPct, 0.1);
  assert.equal(hour10.flatCash, 100);
  approxEqual(hour10.production.cash, (1000 * day1MoraleMultiplier * 1.1) + 100);
});

test("AI2 interpolates from 0.10 to 0.20 and flat cash steps after completion", () => {
  const buildings = validateBuildingsFile(path.resolve("data/buildings.yml"));
  const city: CityState = {
    cityId: "alpha",
    baseHourlyProduction: { ...zeroBaseProduction(), cash: 1000 },
    buildings: { arms_industry: 0, underground_bunkers: 0 },
  };

  const result = simulateBuildOrder({
    cities: [city],
    buildOrder: [{ cityId: "alpha", buildingId: "arms_industry", targetLevel: 2, startHour: 0 }],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 40,
  });

  const hour10 = result.perHourPerCity.find(row => row.cityId === "alpha" && row.hour === 10);
  const hour35 = result.perHourPerCity.find(row => row.cityId === "alpha" && row.hour === 35);
  const hour36 = result.perHourPerCity.find(row => row.cityId === "alpha" && row.hour === 36);

  assert.ok(hour10);
  assert.ok(hour35);
  assert.ok(hour36);

  const ai2ProgressAtHour10 = (660 - 585) / 1560;
  approxEqual(hour10.effectiveBonusPct, 0.1 + ((0.2 - 0.1) * ai2ProgressAtHour10));
  assert.equal(hour10.flatCash, 100);

  approxEqual(hour35.effectiveBonusPct, 0.2);
  assert.equal(hour35.flatCash, 100);

  approxEqual(hour36.effectiveBonusPct, 0.2);
  assert.equal(hour36.flatCash, 135);
});

test("different build orders produce different cumulative cash totals", () => {
  const buildings = validateBuildingsFile(path.resolve("data/buildings.yml"));
  const city: CityState = {
    cityId: "alpha",
    baseHourlyProduction: { ...zeroBaseProduction(), cash: 1000 },
    buildings: { arms_industry: 0, underground_bunkers: 0 },
  };

  const early = simulateBuildOrder({
    cities: [city],
    buildOrder: [{ cityId: "alpha", buildingId: "arms_industry", targetLevel: 1, startHour: 0 }],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 24,
  });

  const late = simulateBuildOrder({
    cities: [city],
    buildOrder: [{ cityId: "alpha", buildingId: "arms_industry", targetLevel: 1, startHour: 20 }],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 24,
  });

  const earlyCash = early.perHourAggregate.reduce((sum, row) => sum + row.production.cash, 0);
  const lateCash = late.perHourAggregate.reduce((sum, row) => sum + row.production.cash, 0);

  assert.ok(earlyCash > lateCash);
});

test("bunkerMoraleBonusN returns the expected morale modifier", () => {
  assert.equal(bunkerMoraleBonusN(0), 0);
  assert.equal(bunkerMoraleBonusN(1), 5);
  assert.equal(bunkerMoraleBonusN(5), 50);
});

test("moraleOnDay uses bunker bonus through N", () => {
  assert.equal(moraleOnDay(2, { S: 70, T: 90, N: 0, D: 8 }), 73);
  assert.equal(moraleOnDay(3, { S: 70, T: 90, N: 0, D: 8 }), 75);
  assert.equal(moraleOnDay(3, { S: 70, T: 90, N: 5, D: 8 }), 76);
});

test("homeland morale with bunkers keeps T fixed and applies bunker through N", () => {
  assert.equal(homelandMoraleOnDayWithBunkers(1, 0), baselineHomelandMoraleOnDay(1));
  assert.equal(homelandMoraleOnDayWithBunkers(2, 1), 72);
});

test("moraleProductionMultiplier remains the baseline coefficient mapping", () => {
  approxEqual(moraleProductionMultiplier(70), ((70 * 0.8) / 100) + 0.25);
});

test("Underground Bunkers only affect morale and production from the next day boundary", () => {
  const buildings = validateBuildingsFile(path.resolve("data/buildings.yml"));
  const city: CityState = {
    cityId: "alpha",
    baseHourlyProduction: { ...zeroBaseProduction(), supplies: 1000 },
    buildings: { arms_industry: 0, underground_bunkers: 0 },
  };

  const result = simulateBuildOrder({
    cities: [city],
    buildOrder: [
      { cityId: "alpha", buildingId: "underground_bunkers", targetLevel: 1, startHour: 0 },
    ],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 48,
  });

  const hour10 = result.perHourPerCity.find(row => row.cityId === "alpha" && row.hour === 10);
  const hour23 = result.perHourPerCity.find(row => row.cityId === "alpha" && row.hour === 23);
  const hour24 = result.perHourPerCity.find(row => row.cityId === "alpha" && row.hour === 24);
  const hour47 = result.perHourPerCity.find(row => row.cityId === "alpha" && row.hour === 47);
  const debug10 = result.debug?.find(row => row.cityId === "alpha" && row.hour === 10);
  const debug23 = result.debug?.find(row => row.cityId === "alpha" && row.hour === 23);
  const debug24 = result.debug?.find(row => row.cityId === "alpha" && row.hour === 24);
  const debug47 = result.debug?.find(row => row.cityId === "alpha" && row.hour === 47);

  assert.ok(hour10);
  assert.ok(hour23);
  assert.ok(hour24);
  assert.ok(hour47);
  assert.ok(debug10);
  assert.ok(debug23);
  assert.ok(debug24);
  assert.ok(debug47);

  assert.equal(debug10.bunkerLevelAtDayStart, 0);
  assert.equal(debug23.bunkerLevelAtDayStart, 0);
  assert.equal(debug24.bunkerLevelAtDayStart, 1);
  assert.equal(debug47.bunkerLevelAtDayStart, 1);
  assert.equal(debug10.bunkerMoraleBonusN, 0);
  assert.equal(debug24.bunkerMoraleBonusN, 5);

  const day1Morale = homelandMoraleOnDayWithBunkers(1, 0);
  const day2Morale = homelandMoraleOnDayWithBunkers(2, 1);
  const day1Multiplier = moraleProductionMultiplier(day1Morale);
  const day2Multiplier = moraleProductionMultiplier(day2Morale);

  approxEqual(hour10.production.supplies, 1000 * day1Multiplier);
  approxEqual(hour23.production.supplies, 1000 * day1Multiplier);
  approxEqual(hour24.production.supplies, 1000 * day2Multiplier);
  approxEqual(hour47.production.supplies, 1000 * day2Multiplier);
  assert.ok(hour24.production.supplies > hour23.production.supplies);
  assert.equal(day1Morale, 70);
  assert.equal(day2Morale, 72);
});
