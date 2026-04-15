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
    moraleParams: {
      S: 100,
      T: 100,
      N: 0,
      D: 8,
    },
    buildings: {
      air_base: 0,
      annex_city: 0,
      arms_industry: 0,
      naval_base: 0,
      recruiting_office: 0,
      relocate_headquarters: 0,
      underground_bunkers: 0,
    },
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
      buildings: {
        air_base: 0,
        annex_city: 0,
        arms_industry: 0,
        naval_base: 0,
        recruiting_office: 0,
        relocate_headquarters: 0,
        underground_bunkers: 0,
      },
    },
    {
      cityId: "beta",
      resource: "components",
      startPop: 4,
      buildings: {
        air_base: 0,
        annex_city: 0,
        arms_industry: 0,
        naval_base: 0,
        recruiting_office: 0,
        relocate_headquarters: 0,
        underground_bunkers: 0,
      },
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
    moraleParams: {
      S: 100,
      T: 100,
      N: 0,
      D: 8,
    },
    buildings: {
      air_base: 0,
      annex_city: 0,
      arms_industry: 0,
      naval_base: 0,
      recruiting_office: 0,
      relocate_headquarters: 0,
      underground_bunkers: 0,
    },
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

test("simulateBuildOrder applies interpolated air and naval base bonuses during construction", () => {
  const buildings = buildTestBuildings();
  const city: CityState = {
    cityId: "alpha",
    resource: "electronics",
    startPop: 5,
    buildings: {
      air_base: 1,
      annex_city: 0,
      arms_industry: 0,
      naval_base: 1,
      recruiting_office: 0,
      relocate_headquarters: 0,
      underground_bunkers: 0,
    },
  };

  const baseline = simulateBuildOrder({
    cities: [city],
    buildOrder: [],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 1,
  });
  const upgrading = simulateBuildOrder({
    cities: [city],
    buildOrder: [
      { cityId: "alpha", buildingId: "air_base", targetLevel: 2, startHour: 0 },
      { cityId: "alpha", buildingId: "naval_base", targetLevel: 2, startHour: 24 },
    ],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 1,
  });

  assert.ok(upgrading.perHourPerCity[0].effectiveBonusPct > baseline.perHourPerCity[0].effectiveBonusPct);
  assert.ok(upgrading.perHourPerCity[0].multiplier > baseline.perHourPerCity[0].multiplier);
});

test("simulateBuildOrder applies city-status multipliers", () => {
  const buildings = buildTestBuildings();
  const homelandCity: CityState = {
    cityId: "alpha",
    resource: "electronics",
    startPop: 5,
    cityStatus: "homeland",
    buildings: {
      air_base: 0,
      annex_city: 0,
      arms_industry: 0,
      naval_base: 0,
      recruiting_office: 0,
      relocate_headquarters: 0,
      underground_bunkers: 0,
    },
  };
  const occupiedCity: CityState = {
    ...homelandCity,
    cityStatus: "occupied",
  };

  const homeland = simulateBuildOrder({
    cities: [homelandCity],
    buildOrder: [],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 1,
  });
  const occupied = simulateBuildOrder({
    cities: [occupiedCity],
    buildOrder: [],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 1,
  });

  assert.ok(homeland.perHourPerCity[0].production.electronics > occupied.perHourPerCity[0].production.electronics);
});


test("simulateBuildOrder annexes a city only after annex_city completes", () => {
  const buildings = buildTestBuildings();
  const city: CityState = {
    cityId: "alpha",
    resource: "electronics",
    startPop: 5,
    cityStatus: "occupied",
    buildings: {
      air_base: 0,
      annex_city: 0,
      arms_industry: 0,
      naval_base: 0,
      recruiting_office: 0,
      relocate_headquarters: 0,
      underground_bunkers: 0,
    },
  };

  const early = simulateBuildOrder({
    cities: [city],
    buildOrder: [{ cityId: "alpha", buildingId: "annex_city", targetLevel: 1, startHour: 0 }],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 1,
  });
  const late = simulateBuildOrder({
    cities: [city],
    buildOrder: [{ cityId: "alpha", buildingId: "annex_city", targetLevel: 1, startHour: 0 }],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 40,
  });

  assert.equal(early.perHourPerCity[0].production.electronics, simulateBuildOrder({
    cities: [city],
    buildOrder: [],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 1,
  }).perHourPerCity[0].production.electronics);
  assert.ok(
    late.perHourPerCity[late.perHourPerCity.length - 1].production.electronics >
      early.perHourPerCity[0].production.electronics
  );
});

test("simulateBuildOrder applies recruiting office manpower only after completion", () => {
  const buildings = buildTestBuildings();
  const city: CityState = {
    cityId: "alpha",
    resource: "electronics",
    startPop: 5,
    moraleParams: {
      S: 100,
      T: 100,
      N: 0,
      D: 8,
    },
    buildings: {
      air_base: 0,
      annex_city: 0,
      arms_industry: 0,
      naval_base: 0,
      recruiting_office: 0,
      relocate_headquarters: 0,
      underground_bunkers: 0,
    },
  };

  const beforeCompletion = simulateBuildOrder({
    cities: [city],
    buildOrder: [{ cityId: "alpha", buildingId: "recruiting_office", targetLevel: 1, startHour: 0 }],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 1,
  });
  const afterCompletion = simulateBuildOrder({
    cities: [city],
    buildOrder: [{ cityId: "alpha", buildingId: "recruiting_office", targetLevel: 1, startHour: 0 }],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 2,
  });

  assert.equal(beforeCompletion.perHourPerCity[0].production.manpower, Math.floor(140 / 24));
  assert.equal(afterCompletion.perHourPerCity[1].production.manpower, Math.floor(260 / 24));
});

test("simulateBuildOrder transfers headquarters morale bonus on relocate completion", () => {
  const buildings = buildTestBuildings();
  const capital: CityState = {
    cityId: "capital",
    countryId: "alpha",
    capital: true,
    resource: "electronics",
    startPop: 5,
    cityStatus: "homeland",
    buildings: {
      air_base: 0,
      annex_city: 0,
      arms_industry: 0,
      naval_base: 0,
      relocate_headquarters: 0,
      underground_bunkers: 0,
    },
  };
  const destination: CityState = {
    ...capital,
    cityId: "destination",
    capital: false,
  };

  const baseline = simulateBuildOrder({
    cities: [capital, destination],
    buildOrder: [],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 80,
  });
  const relocated = simulateBuildOrder({
    cities: [capital, destination],
    buildOrder: [
      { cityId: "destination", buildingId: "relocate_headquarters", targetLevel: 1, startHour: 0 },
    ],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 80,
  });

  const baselineCapital = baseline.perHourPerCity
    .filter(row => row.cityId === "capital")
    .at(-1);
  const baselineDestination = baseline.perHourPerCity
    .filter(row => row.cityId === "destination")
    .at(-1);
  const relocatedCapital = relocated.perHourPerCity
    .filter(row => row.cityId === "capital")
    .at(-1);
  const relocatedDestination = relocated.perHourPerCity
    .filter(row => row.cityId === "destination")
    .at(-1);

  assert.ok(baselineCapital);
  assert.ok(baselineDestination);
  assert.ok(relocatedCapital);
  assert.ok(relocatedDestination);
  assert.ok(relocatedDestination.multiplier > baselineDestination.multiplier);
  assert.ok(relocatedCapital.multiplier < baselineCapital.multiplier);
});

test("simulateBuildOrder does not grant headquarters morale to an isolated non-capital city before relocate completes", () => {
  const buildings = buildTestBuildings();
  const city: CityState = {
    cityId: "alpha",
    countryId: "solo",
    capital: false,
    resource: "electronics",
    startPop: 5,
    cityStatus: "homeland",
    buildings: {
      air_base: 0,
      annex_city: 0,
      arms_industry: 0,
      naval_base: 0,
      relocate_headquarters: 0,
      underground_bunkers: 0,
    },
  };

  const baseline = simulateBuildOrder({
    cities: [city],
    buildOrder: [],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 80,
  });
  const relocated = simulateBuildOrder({
    cities: [city],
    buildOrder: [
      { cityId: "alpha", buildingId: "relocate_headquarters", targetLevel: 1, startHour: 0 },
    ],
    buildings,
    scenario: TEST_SCENARIO,
    hoursToSimulate: 80,
  });

  const baselineFinal = baseline.perHourPerCity.at(-1);
  const relocatedFinal = relocated.perHourPerCity.at(-1);

  assert.ok(baselineFinal);
  assert.ok(relocatedFinal);
  assert.ok(relocatedFinal.multiplier > baselineFinal.multiplier);
  assert.ok(
    relocated.timingDebug?.builds.some(build => build.buildingId === "relocate_headquarters")
  );
});
