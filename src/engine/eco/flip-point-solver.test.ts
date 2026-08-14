import assert from "node:assert/strict";
import test from "node:test";

import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import type { CityEcoResult } from "./city-eco-beam.js";
import { computeEcoBackfill, withBackfilledLevels } from "./flip-point-solver.js";

const buildings = loadBuildingsFile();

function makeEcoResult(opts: {
  lastEcoBuildCompletionAbsHour: number;
  levels?: Partial<Record<string, number>>;
}): CityEcoResult {
  const levels = { ...(opts.levels ?? {}) };
  return {
    cityId: "test:city",
    cityName: "Test City",
    resource: "fuel",
    capital: false,
    startingLevels: levels,
    bestActions: [],
    buildingLevelsAtAbsHour: () => levels,
    lastEcoBuildCompletionAbsHour: opts.lastEcoBuildCompletionAbsHour,
    endingBalances: {},
    hourlyCityProduction: [],
    totalEcoBuildCost: {},
    top: [],
    explored: 0,
  } as unknown as CityEcoResult;
}

test("computeEcoBackfill returns nothing when the idle window is empty (windowEnd <= lastEcoBuildCompletionAbsHour)", () => {
  const eco = makeEcoResult({ lastEcoBuildCompletionAbsHour: 100 });
  const steps = computeEcoBackfill(eco, { recruiting_office: 2 }, 100, buildings);
  assert.deepEqual(steps, []);
});

test("computeEcoBackfill returns nothing when the beam already built everything required", () => {
  const eco = makeEcoResult({ lastEcoBuildCompletionAbsHour: 50, levels: { recruiting_office: 2 } });
  const steps = computeEcoBackfill(eco, { recruiting_office: 2 }, 500, buildings);
  assert.deepEqual(steps, []);
});

test("computeEcoBackfill schedules a guaranteed level that fits in the idle window, with real timestamps", () => {
  // recruiting_office L1->L2 takes 26h (1d 2h) per buildings.yml.
  const eco = makeEcoResult({ lastEcoBuildCompletionAbsHour: 100, levels: { recruiting_office: 1 } });
  const steps = computeEcoBackfill(eco, { recruiting_office: 2 }, 200, buildings);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].buildingId, "recruiting_office");
  assert.equal(steps[0].fromLevel, 1);
  assert.equal(steps[0].toLevel, 2);
  assert.equal(steps[0].startHour, 100);
  assert.equal(steps[0].endHour, 126);
});

test("computeEcoBackfill skips a building that doesn't fit and still backfills a later, cheaper one", () => {
  // Default order (CHAIN_ORDER) checks arms_industry before recruiting_office.
  // arms_industry L1 costs 9h and doesn't fit in the 5h window, but that must not
  // block recruiting_office L1 (0.5h) — which fits — from being backfilled. Once a
  // building fails to fit, remaining budget only shrinks, so it's skipped for the
  // rest of the walk rather than aborting the whole thing.
  const eco = makeEcoResult({ lastEcoBuildCompletionAbsHour: 100 });
  const steps = computeEcoBackfill(eco, { arms_industry: 1, recruiting_office: 1 }, 105, buildings);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].buildingId, "recruiting_office");
  assert.equal(steps[0].fromLevel, 0);
  assert.equal(steps[0].toLevel, 1);
  assert.equal(steps[0].startHour, 100);
  assert.equal(steps[0].endHour, 100.5);
});

test("computeEcoBackfill respects a custom orderBuildings (e.g. RO-first) and schedules multiple levels sequentially", () => {
  const roFirst = (ids: string[]) => [
    ...ids.filter(id => id === "recruiting_office"),
    ...ids.filter(id => id !== "recruiting_office"),
  ];
  const eco = makeEcoResult({ lastEcoBuildCompletionAbsHour: 0 });
  // RO L1 (0.5h) + arms_industry L1 (9h) = 9.5h, comfortably inside a 50h window.
  const steps = computeEcoBackfill(eco, { recruiting_office: 1, arms_industry: 1 }, 50, buildings, roFirst);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].buildingId, "recruiting_office");
  assert.equal(steps[1].buildingId, "arms_industry");
  assert.ok(steps[1].startHour >= steps[0].endHour, "second step must start no earlier than the first ends (sequential queue)");
});

test("withBackfilledLevels credits a backfilled step only once its endHour has passed", () => {
  const eco = makeEcoResult({ lastEcoBuildCompletionAbsHour: 100, levels: { recruiting_office: 1 } });
  const [step] = computeEcoBackfill(eco, { recruiting_office: 2 }, 200, buildings);
  const augmented = withBackfilledLevels(eco, [step]);

  assert.equal((augmented.buildingLevelsAtAbsHour(step.endHour - 1) as Record<string, number | undefined>).recruiting_office, 1);
  assert.equal((augmented.buildingLevelsAtAbsHour(step.endHour) as Record<string, number | undefined>).recruiting_office, 2);
});

test("withBackfilledLevels returns the original result unchanged when there are no backfill steps", () => {
  const eco = makeEcoResult({ lastEcoBuildCompletionAbsHour: 100 });
  assert.equal(withBackfilledLevels(eco, []), eco);
});
