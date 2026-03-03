import assert from "node:assert/strict";
import test from "node:test";

import { effectiveDurationFromMorale } from "./activity-duration.js";

test("effectiveDurationFromMorale keeps base duration at high morale", () => {
  assert.equal(effectiveDurationFromMorale(600, 90), 600);
  assert.equal(effectiveDurationFromMorale(600, 100), 600);
});

test("effectiveDurationFromMorale applies the maximum slowdown at low morale", () => {
  assert.equal(effectiveDurationFromMorale(600, 25), 800);
  assert.equal(effectiveDurationFromMorale(600, 0), 800);
});

test("effectiveDurationFromMorale interpolates smoothly between 25 and 90 morale", () => {
  const atMidpoint = effectiveDurationFromMorale(600, 57.5);
  assert.ok(Math.abs(atMidpoint - 685.7142857142858) < 1e-9);

  const atSeventy = effectiveDurationFromMorale(600, 70);
  assert.ok(Math.abs(atSeventy - 650) < 1e-9);
});

test("effectiveDurationFromMorale validates its inputs", () => {
  assert.throws(() => effectiveDurationFromMorale(-1, 70), /baseDuration must be >= 0/);
  assert.throws(() => effectiveDurationFromMorale(600, -1), /moralePct must be between 0 and 100/);
  assert.throws(() => effectiveDurationFromMorale(600, 101), /moralePct must be between 0 and 100/);
});
