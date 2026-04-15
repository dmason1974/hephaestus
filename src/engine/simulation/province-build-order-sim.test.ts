import test from "node:test";
import assert from "node:assert/strict";

import { simulateProvinceBuildOrder, type ProvinceState } from "./province-build-order-sim.js";
import { buildTestBuildings } from "../../test-support/buildings-fixture.js";

const TEST_SCENARIO = {
  start: {
    day: 1,
    hour: 0,
  },
  speed: "4x",
} as const;

test("simulateProvinceBuildOrder returns the expected result structure", () => {
  const buildings = buildTestBuildings();
  const province: ProvinceState = {
    provinceId: "alpha_provinces",
    resource: "supplies",
    resourceProvinceCount: 2,
    totalProvinceCount: 10,
    buildings: {
      combat_outpost: 0,
      local_industry: 0,
    },
  };

  const result = simulateProvinceBuildOrder({
    provinces: [province],
    buildOrder: [{ provinceId: "alpha_provinces", buildingId: "local_industry", targetLevel: 1 }],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 4,
  });

  assert.equal(result.hoursSimulated, 4);
  assert.equal(result.perHourPerProvince.length, 4);
  assert.equal(result.perHourAggregate.length, 4);
  assert.equal(result.perHourPerProvince[0]?.provinceId, "alpha_provinces");
});

test("simulateProvinceBuildOrder applies interpolated local industry benefit during construction", () => {
  const buildings = buildTestBuildings();
  const province: ProvinceState = {
    provinceId: "alpha_provinces",
    resource: "supplies",
    resourceProvinceCount: 2,
    totalProvinceCount: 10,
    buildings: {
      combat_outpost: 0,
      local_industry: 0,
    },
  };

  const baseline = simulateProvinceBuildOrder({
    provinces: [province],
    buildOrder: [],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 1,
  });
  const upgrading = simulateProvinceBuildOrder({
    provinces: [province],
    buildOrder: [{ provinceId: "alpha_provinces", buildingId: "local_industry", targetLevel: 1 }],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 1,
  });

  assert.ok(
    upgrading.perHourPerProvince[0].production.supplies >
      baseline.perHourPerProvince[0].production.supplies
  );
});

test("simulateProvinceBuildOrder applies combat outpost morale like bunker-style day-based morale", () => {
  const buildings = buildTestBuildings();
  const province: ProvinceState = {
    provinceId: "alpha_provinces",
    resource: "supplies",
    resourceProvinceCount: 2,
    totalProvinceCount: 10,
    buildings: {
      combat_outpost: 0,
      local_industry: 0,
    },
  };

  const baseline = simulateProvinceBuildOrder({
    provinces: [province],
    buildOrder: [],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 96,
  });
  const improved = simulateProvinceBuildOrder({
    provinces: [province],
    buildOrder: [{ provinceId: "alpha_provinces", buildingId: "combat_outpost", targetLevel: 1 }],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 96,
  });

  const baselineHour72 = baseline.perHourPerProvince.filter(row => row.hour === 72).at(0);
  const improvedHour72 = improved.perHourPerProvince.filter(row => row.hour === 72).at(0);

  assert.ok(baselineHour72);
  assert.ok(improvedHour72);
  assert.ok((improvedHour72?.production.cash ?? 0) > (baselineHour72?.production.cash ?? 0));
});
