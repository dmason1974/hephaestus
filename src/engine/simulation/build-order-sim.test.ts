import test from "node:test";
import assert from "node:assert/strict";

import { simulateBuildOrder, type CityState } from "./build-order-sim.js";
import { buildTestBuildings } from "../../test-support/buildings-fixture.js";

const TEST_SCENARIO = {
  start: {
    day: 1,
    hour: 0,
  },
  speed: "4x",
} as const;

test("simulateBuildOrder returns the expected result structure for a proposed build order", () => {
  const buildings = buildTestBuildings();
  const city: CityState = {
    cityId: "alpha",
    resource: "electronics",
    startPop: 5,
    buildings: { arms_industry: 0, underground_bunkers: 0 },
  };

  const result = simulateBuildOrder({
    cities: [city],
    buildOrder: [{ cityId: "alpha", buildingId: "arms_industry", targetLevel: 1, startHour: 0 }],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 12,
  });

  assert.equal(result.hoursSimulated, 12);
  assert.equal(result.perHourPerCity.length, 12);
  assert.equal(result.perHourAggregate.length, 12);
  assert.equal(result.debug?.length, 12);
  assert.equal(result.timingDebug?.scenarioStartDay, 1);
  assert.equal(result.timingDebug?.scenarioStartHour, 0);
  assert.equal(result.timingDebug?.scenarioStartAbsoluteHour, 0);
  assert.equal(result.timingDebug?.builds.length, 1);
  assert.equal(result.timingDebug?.days.length, 1);

  const firstRow = result.perHourPerCity[0];
  assert.equal(firstRow.cityId, "alpha");
  assert.equal(firstRow.hour, 0);
  assert.ok(typeof firstRow.multiplier === "number");
  assert.ok(typeof firstRow.effectiveBonusPct === "number");
  assert.ok(typeof firstRow.production.cash === "number");
  assert.ok(typeof firstRow.production.electronics === "number");
});

test("simulateBuildOrder aggregates per-city hourly production into per-hour totals", () => {
  const buildings = buildTestBuildings();
  const cities: CityState[] = [
    {
      cityId: "alpha",
      resource: "electronics",
      startPop: 5,
      buildings: { arms_industry: 0, underground_bunkers: 0 },
    },
    {
      cityId: "beta",
      resource: "components",
      startPop: 4,
      buildings: { arms_industry: 0, underground_bunkers: 0 },
    },
  ];

  const result = simulateBuildOrder({
    cities,
    buildOrder: [],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 4,
  });

  for (const aggregateRow of result.perHourAggregate) {
    const perCityRows = result.perHourPerCity.filter(row => row.hour === aggregateRow.hour);
    const expectedCash = perCityRows.reduce((sum, row) => sum + row.production.cash, 0);
    assert.equal(aggregateRow.production.cash, expectedCash);
  }
});

test("different build orders produce different cumulative cash totals", () => {
  const buildings = buildTestBuildings();
  const city: CityState = {
    cityId: "alpha",
    resource: "electronics",
    startPop: 5,
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
