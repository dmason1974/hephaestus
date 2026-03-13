import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTimeToMinutes,
  getBuildingStateAtHourEnd,
  getCompletedBuildingLevelAtDayStart,
  scheduleBuildSegments,
  type TimelineCityState,
} from "./build-order-timeline.js";
import { effectiveDurationFromMorale } from "../timing/activity-duration.js";
import { buildTestBuildings } from "../../test-support/buildings-fixture.js";

const TEST_SCENARIO = {
  start: {
    day: 1,
    hour: 0,
  },
} as const;

function loadBuildings() {
  return buildTestBuildings();
}

function baseCity(buildings?: Partial<TimelineCityState["buildings"]>): TimelineCityState {
  return {
    cityId: "alpha",
    capital: true,
    cityStatus: "homeland",
    buildings: {
      air_base: 0,
      annex_city: 0,
      arms_industry: 0,
      naval_base: 0,
      recruiting_office: 0,
      relocate_headquarters: 0,
      underground_bunkers: 0,
      ...buildings,
    },
  };
}

test("buildTimeToMinutes converts mixed units to total minutes", () => {
  assert.equal(buildTimeToMinutes({ days: 1, hours: 2, minutes: 3, seconds: 30 }), 1563.5);
  assert.equal(buildTimeToMinutes({}), 0);
});

test("scheduleBuildSegments expands target levels into sequential timed segments", () => {
  const buildings = loadBuildings();
  const segmentsByCity = scheduleBuildSegments({
    cities: [baseCity()],
    buildOrder: [{ cityId: "alpha", buildingId: "arms_industry", targetLevel: 2, startHour: 0 }],
    buildings,
    scenario: TEST_SCENARIO,
  });

  const segments = segmentsByCity.get("alpha")?.arms_industry;
  assert.ok(segments);
  assert.equal(segments.length, 2);

  assert.deepEqual(
    segments.map(segment => ({
      fromLevel: segment.fromLevel,
      toLevel: segment.toLevel,
      startMinute: segment.startMinute,
      endMinute: segment.endMinute,
      startRelHour: segment.startRelHour,
    })),
    [
      {
        fromLevel: 0,
        toLevel: 1,
        startMinute: 0,
        endMinute: effectiveDurationFromMorale(585, 70),
        startRelHour: 0,
      },
      {
        fromLevel: 1,
        toLevel: 2,
        startMinute: effectiveDurationFromMorale(585, 70),
        endMinute: effectiveDurationFromMorale(585, 70) + effectiveDurationFromMorale(1560, 70),
        startRelHour: effectiveDurationFromMorale(585, 70) / 60,
      },
    ]
  );
});

test("scheduleBuildSegments requires each base upgrade level to complete before the next starts", () => {
  const buildings = loadBuildings();
  const segments = scheduleBuildSegments({
    cities: [baseCity({ naval_base: 1 })],
    buildOrder: [{ cityId: "alpha", buildingId: "naval_base", targetLevel: 5, startHour: 0 }],
    buildings,
    scenario: TEST_SCENARIO,
  }).get("alpha")?.naval_base;

  assert.ok(segments);
  assert.equal(segments.length, 4);
  assert.deepEqual(
    segments.map(segment => [segment.fromLevel, segment.toLevel]),
    [
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ]
  );

  for (let index = 1; index < segments.length; index++) {
    assert.equal(segments[index].startMinute, segments[index - 1].endMinute);
  }
});

test("scheduleBuildSegments respects city availability when later actions overlap", () => {
  const buildings = loadBuildings();
  const segmentsByCity = scheduleBuildSegments({
    cities: [baseCity()],
    buildOrder: [
      { cityId: "alpha", buildingId: "arms_industry", targetLevel: 1, startHour: 0 },
      { cityId: "alpha", buildingId: "underground_bunkers", targetLevel: 1, startHour: 0 },
    ],
    buildings,
    scenario: TEST_SCENARIO,
  });

  const bunkerSegment = segmentsByCity.get("alpha")?.underground_bunkers[0];
  assert.ok(bunkerSegment);
  assert.equal(bunkerSegment.startMinute, effectiveDurationFromMorale(585, 70));
  assert.equal(bunkerSegment.startRelHour, effectiveDurationFromMorale(585, 70) / 60);
});

test("getBuildingStateAtHourEnd reports interpolated progress and delayed flat-bonus activation", () => {
  const buildings = loadBuildings();
  const segments = scheduleBuildSegments({
    cities: [baseCity()],
    buildOrder: [{ cityId: "alpha", buildingId: "arms_industry", targetLevel: 1, startHour: 0 }],
    buildings,
    scenario: TEST_SCENARIO,
  }).get("alpha")?.arms_industry;

  assert.ok(segments);

  assert.deepEqual(
    getBuildingStateAtHourEnd({ hour: 0, segments, scenario: TEST_SCENARIO }),
    {
      currentFromLevel: 0,
      currentToLevel: 1,
      progressRatio: 60 / effectiveDurationFromMorale(585, 70),
      segmentStartMinute: 0,
      segmentEndMinute: effectiveDurationFromMorale(585, 70),
      flatCashActiveLevel: 0,
    }
  );

  assert.deepEqual(
    getBuildingStateAtHourEnd({ hour: 13, segments, scenario: TEST_SCENARIO }),
    {
      currentFromLevel: 1,
      currentToLevel: 1,
      progressRatio: 1,
      segmentStartMinute: 0,
      segmentEndMinute: effectiveDurationFromMorale(585, 70),
      flatCashActiveLevel: 1,
    }
  );
});

test("getCompletedBuildingLevelAtDayStart activates bunker levels from the next day boundary", () => {
  const buildings = loadBuildings();
  const segments = scheduleBuildSegments({
    cities: [baseCity()],
    buildOrder: [
      { cityId: "alpha", buildingId: "underground_bunkers", targetLevel: 1, startHour: 0 },
    ],
    buildings,
    scenario: TEST_SCENARIO,
  }).get("alpha")?.underground_bunkers;

  assert.ok(segments);
  assert.equal(getCompletedBuildingLevelAtDayStart({ mapDay: 1, startingLevel: 0, segments }), 0);
  assert.equal(getCompletedBuildingLevelAtDayStart({ mapDay: 2, startingLevel: 0, segments }), 0);
  assert.equal(getCompletedBuildingLevelAtDayStart({ mapDay: 3, startingLevel: 0, segments }), 1);
});

test("getCompletedBuildingLevelAtDayStart uses fixed map-day boundaries for offset scenario starts", () => {
  const buildings = loadBuildings();
  const offsetScenario = {
    start: {
      day: 1,
      hour: 15,
    },
  } as const;

  const segments = scheduleBuildSegments({
    cities: [baseCity()],
    buildOrder: [
      { cityId: "alpha", buildingId: "underground_bunkers", targetLevel: 1, startHour: 0 },
    ],
    buildings,
    scenario: offsetScenario,
  }).get("alpha")?.underground_bunkers;

  assert.ok(segments);
  assert.equal(getCompletedBuildingLevelAtDayStart({ mapDay: 1, startingLevel: 0, segments }), 0);
  assert.equal(getCompletedBuildingLevelAtDayStart({ mapDay: 2, startingLevel: 0, segments }), 0);
  assert.equal(getCompletedBuildingLevelAtDayStart({ mapDay: 3, startingLevel: 0, segments }), 1);
});

test("scheduleBuildSegments allows air_base builds in inland cities", () => {
  const buildings = loadBuildings();
  const segments = scheduleBuildSegments({
    cities: [baseCity()],
    buildOrder: [{ cityId: "alpha", buildingId: "air_base", targetLevel: 1, startHour: 0 }],
    buildings,
    scenario: TEST_SCENARIO,
  }).get("alpha")?.air_base;

  assert.ok(segments);
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.toLevel, 1);
});

test("scheduleBuildSegments rejects naval_base builds for non-coastal cities", () => {
  const buildings = loadBuildings();

  assert.throws(
    () =>
      scheduleBuildSegments({
        cities: [baseCity()],
        buildOrder: [{ cityId: "alpha", buildingId: "naval_base", targetLevel: 1, startHour: 0 }],
        buildings,
        scenario: TEST_SCENARIO,
      }),
    /cannot build naval_base/
  );
});

test("scheduleBuildSegments allows naval_base upgrades for coastal cities", () => {
  const buildings = loadBuildings();
  const segments = scheduleBuildSegments({
    cities: [baseCity({ naval_base: 1 })],
    buildOrder: [{ cityId: "alpha", buildingId: "naval_base", targetLevel: 2, startHour: 0 }],
    buildings,
    scenario: TEST_SCENARIO,
  }).get("alpha")?.naval_base;

  assert.ok(segments);
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.fromLevel, 1);
  assert.equal(segments[0]?.toLevel, 2);
});

test("scheduleBuildSegments rejects annex_city for non-occupied cities", () => {
  const buildings = loadBuildings();

  assert.throws(
    () =>
      scheduleBuildSegments({
        cities: [baseCity()],
        buildOrder: [{ cityId: "alpha", buildingId: "annex_city", targetLevel: 1, startHour: 0 }],
        buildings,
        scenario: TEST_SCENARIO,
      }),
    /cannot build annex_city/
  );
});
