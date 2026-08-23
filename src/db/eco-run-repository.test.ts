import assert from "node:assert/strict";
import test from "node:test";

import type { Resource } from "../core/constants.js";
import type { BuildAction } from "../engine/orchestration/build-order-timeline.js";
import { actionHours, bareCityId, sumHourly } from "./eco-run-repository.js";

test("bareCityId strips the engine's country prefix", () => {
  // Unit 1 keys city results as `${countryId}:${cityId}`; Unit 2 uses bare ids.
  // Storing bare is what keeps later cross-unit joins working.
  assert.equal(bareCityId("italy:rome"), "rome");
});

test("bareCityId leaves an already-bare id untouched", () => {
  assert.equal(bareCityId("rome"), "rome");
});

test("bareCityId keeps any further colons in the city id", () => {
  // Guards against a naive split(":")[1] losing part of the id.
  assert.equal(bareCityId("italy:san:marino"), "san:marino");
});

test("sumHourly totals an hourly series per resource", () => {
  const hour = (supplies: number, cash: number): Record<Resource, number> => ({
    supplies, components: 0, fuel: 0, rares: 0, electronics: 0, cash, manpower: 0,
  });
  const total = sumHourly([hour(10, 1), hour(5, 2), hour(1, 3)]);
  assert.equal(total.supplies, 16);
  assert.equal(total.cash, 6);
  assert.equal(total.fuel, 0);
});

test("sumHourly returns zeros for an empty series", () => {
  assert.deepEqual(sumHourly([]), {
    supplies: 0, components: 0, fuel: 0, rares: 0, electronics: 0, cash: 0, manpower: 0,
  });
});

test("actionHours prefers startRelHour over startHour, matching the timeline", () => {
  // build-order-timeline resolves these as `startRelHour ?? startHour ?? 0`.
  const action = {
    cityId: "italy:rome", buildingId: "arms_industry", targetLevel: 1,
    startRelHour: 4, startHour: 99,
  } as BuildAction;
  assert.deepEqual(actionHours(action, 15), { rel: 4, abs: 19 });
});

test("actionHours falls back to startHour and derives the absolute hour", () => {
  const action = {
    cityId: "italy:rome", buildingId: "arms_industry", targetLevel: 1, startHour: 10,
  } as BuildAction;
  assert.deepEqual(actionHours(action, 15), { rel: 10, abs: 25 });
});

test("actionHours reports null rather than defaulting an absent hour to zero", () => {
  // A missing start hour is unknown, not hour 0 — storing 0 would silently
  // claim the build started at scenario start.
  const action = {
    cityId: "italy:rome", buildingId: "arms_industry", targetLevel: 1,
  } as BuildAction;
  assert.deepEqual(actionHours(action, 15), { rel: null, abs: null });
});
