import test from "node:test";
import assert from "node:assert/strict";

import {
  defaultStartingMoraleForCityStatus,
  defaultStartingPopulationForCityStatus,
} from "./constants.js";

test("captured city defaults use lower morale and population", () => {
  assert.equal(defaultStartingMoraleForCityStatus("homeland"), 70);
  assert.equal(defaultStartingMoraleForCityStatus("occupied"), 25);
  assert.equal(defaultStartingMoraleForCityStatus("annexed"), 25);

  assert.equal(defaultStartingPopulationForCityStatus(6, "homeland"), 6);
  assert.equal(defaultStartingPopulationForCityStatus(6, "occupied"), 4);
  assert.equal(defaultStartingPopulationForCityStatus(5, "annexed"), 4);
});
