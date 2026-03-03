import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTimeToMinutes,
  getBuildingStateAtHourEnd,
  getCompletedBuildingLevelAtDayStart,
  scheduleBuildSegments,
  type TimelineCityState,
} from "../build-order-timeline.js";
import { validateBuildingsFile } from "../../../validation/buildingSchema.js";

const TEST_SCENARIO = {
  start: {
    day: 1,
    hour: 0,
  },
} as const;

function loadBuildings() {
  return validateBuildingsFile(path.resolve("data/buildings.yml"));
}

test("buildTimeToMinutes converts mixed units to total minutes", () => {
  assert.equal(buildTimeToMinutes({ days: 1, hours: 2, minutes: 3, seconds: 30 }), 1563.5);
  assert.equal(buildTimeToMinutes({}), 0);
});

test("scheduleBuildSegments expands target levels into sequential timed segments", () => {
  const buildings = loadBuildings();
  const cities: TimelineCityState[] = [
    {
      cityId: "alpha",
      buildings: { arms_industry: 0, underground_bunkers: 0 },
    },
  ];

  const segmentsByCity = scheduleBuildSegments({
    cities,
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
        endMinute: 585,
        startRelHour: 0,
      },
      {
        fromLevel: 1,
        toLevel: 2,
        startMinute: 585,
        endMinute: 2145,
        startRelHour: 9.75,
      },
    ]
  );
});

test("scheduleBuildSegments respects city availability when later actions overlap", () => {
  const buildings = loadBuildings();
  const cities: TimelineCityState[] = [
    {
      cityId: "alpha",
      buildings: { arms_industry: 0, underground_bunkers: 0 },
    },
  ];

  const segmentsByCity = scheduleBuildSegments({
    cities,
    buildOrder: [
      { cityId: "alpha", buildingId: "arms_industry", targetLevel: 1, startHour: 0 },
      { cityId: "alpha", buildingId: "underground_bunkers", targetLevel: 1, startHour: 0 },
    ],
    buildings,
    scenario: TEST_SCENARIO,
  });

  const bunkerSegment = segmentsByCity.get("alpha")?.underground_bunkers[0];
  assert.ok(bunkerSegment);
  assert.equal(bunkerSegment.startMinute, 585);
  assert.equal(bunkerSegment.startRelHour, 9.75);
});

test("getBuildingStateAtHourEnd reports interpolated progress and delayed flat-bonus activation", () => {
  const buildings = loadBuildings();
  const cities: TimelineCityState[] = [
    {
      cityId: "alpha",
      buildings: { arms_industry: 0, underground_bunkers: 0 },
    },
  ];

  const segments = scheduleBuildSegments({
    cities,
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
      progressRatio: 60 / 585,
      segmentStartMinute: 0,
      segmentEndMinute: 585,
      flatCashActiveLevel: 0,
    }
  );

  assert.deepEqual(
    getBuildingStateAtHourEnd({ hour: 10, segments, scenario: TEST_SCENARIO }),
    {
      currentFromLevel: 1,
      currentToLevel: 1,
      progressRatio: 1,
      segmentStartMinute: 0,
      segmentEndMinute: 585,
      flatCashActiveLevel: 1,
    }
  );
});

test("getCompletedBuildingLevelAtDayStart activates bunker levels from the next day boundary", () => {
  const buildings = loadBuildings();
  const cities: TimelineCityState[] = [
    {
      cityId: "alpha",
      buildings: { arms_industry: 0, underground_bunkers: 0 },
    },
  ];

  const segments = scheduleBuildSegments({
    cities,
    buildOrder: [
      { cityId: "alpha", buildingId: "underground_bunkers", targetLevel: 1, startHour: 0 },
    ],
    buildings,
    scenario: TEST_SCENARIO,
  }).get("alpha")?.underground_bunkers;

  assert.ok(segments);
  assert.equal(
    getCompletedBuildingLevelAtDayStart({
      mapDay: 1,
      startingLevel: 0,
      segments,
    }),
    0
  );
  assert.equal(
    getCompletedBuildingLevelAtDayStart({
      mapDay: 2,
      startingLevel: 0,
      segments,
    }),
    1
  );
});

test("getCompletedBuildingLevelAtDayStart uses fixed map-day boundaries for offset scenario starts", () => {
  const buildings = loadBuildings();
  const offsetScenario = {
    start: {
      day: 1,
      hour: 15,
    },
  } as const;
  const cities: TimelineCityState[] = [
    {
      cityId: "alpha",
      buildings: { arms_industry: 0, underground_bunkers: 0 },
    },
  ];

  const segments = scheduleBuildSegments({
    cities,
    buildOrder: [
      { cityId: "alpha", buildingId: "underground_bunkers", targetLevel: 1, startHour: 0 },
    ],
    buildings,
    scenario: offsetScenario,
  }).get("alpha")?.underground_bunkers;

  assert.ok(segments);
  assert.equal(
    getCompletedBuildingLevelAtDayStart({
      mapDay: 1,
      startingLevel: 0,
      segments,
    }),
    0
  );
  assert.equal(
    getCompletedBuildingLevelAtDayStart({
      mapDay: 2,
      startingLevel: 0,
      segments,
    }),
    0
  );
  assert.equal(
    getCompletedBuildingLevelAtDayStart({
      mapDay: 3,
      startingLevel: 0,
      segments,
    }),
    1
  );
});
