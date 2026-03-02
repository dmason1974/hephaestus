import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { simulateBuildOrder, type CityState } from "./build-order-sim.js";
import { validateBuildingsFile } from "../../validation/buildingSchema.js";

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

test("AI1 ramps from 1.0 to 1.10 and flat cash applies after completion hour", () => {
  const buildings = validateBuildingsFile(path.resolve("data/buildings.yml"));
  const city: CityState = {
    cityId: "alpha",
    baseHourlyProduction: { ...zeroBaseProduction(), cash: 1000 },
    buildings: { arms_industry: 0 },
  };

  const result = simulateBuildOrder({
    cities: [city],
    buildOrder: [{ cityId: "alpha", buildingId: "arms_industry", targetLevel: 1, startHour: 0 }],
    buildings,
    hoursToSimulate: 12,
  });

  const hour0 = result.perHourPerCity.find(row => row.cityId === "alpha" && row.hour === 0);
  const hour9 = result.perHourPerCity.find(row => row.cityId === "alpha" && row.hour === 9);
  const hour10 = result.perHourPerCity.find(row => row.cityId === "alpha" && row.hour === 10);

  assert.ok(hour0);
  assert.ok(hour9);
  assert.ok(hour10);

  approxEqual(hour0.effectiveBonusPct, 0.1 * (60 / 585));
  approxEqual(hour0.multiplier, 1 + (0.1 * (60 / 585)));
  assert.equal(hour0.flatCash, 0);

  approxEqual(hour9.effectiveBonusPct, 0.1);
  assert.equal(hour9.flatCash, 0);

  approxEqual(hour10.effectiveBonusPct, 0.1);
  assert.equal(hour10.flatCash, 100);
  approxEqual(hour10.production.cash, 1100 + 100);
});

test("AI2 interpolates from 0.10 to 0.20 and flat cash steps after completion", () => {
  const buildings = validateBuildingsFile(path.resolve("data/buildings.yml"));
  const city: CityState = {
    cityId: "alpha",
    baseHourlyProduction: { ...zeroBaseProduction(), cash: 1000 },
    buildings: { arms_industry: 0 },
  };

  const result = simulateBuildOrder({
    cities: [city],
    buildOrder: [{ cityId: "alpha", buildingId: "arms_industry", targetLevel: 2, startHour: 0 }],
    buildings,
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
    buildings: { arms_industry: 0 },
  };

  const early = simulateBuildOrder({
    cities: [city],
    buildOrder: [{ cityId: "alpha", buildingId: "arms_industry", targetLevel: 1, startHour: 0 }],
    buildings,
    hoursToSimulate: 24,
  });

  const late = simulateBuildOrder({
    cities: [city],
    buildOrder: [{ cityId: "alpha", buildingId: "arms_industry", targetLevel: 1, startHour: 20 }],
    buildings,
    hoursToSimulate: 24,
  });

  const earlyCash = early.perHourAggregate.reduce((sum, row) => sum + row.production.cash, 0);
  const lateCash = late.perHourAggregate.reduce((sum, row) => sum + row.production.cash, 0);

  assert.ok(earlyCash > lateCash);
});
