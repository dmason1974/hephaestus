import test from "node:test";
import assert from "node:assert/strict";

import { aggregateHourlyAmountsByMapDay } from "../scenario-reporting.js";

test("map-day aggregation counts a partial first day from scenario start hour", () => {
  const rows = Array.from({ length: 48 }, (_, index) => ({
    hour: index + 1,
    amount: 1,
  }));

  const aggregated = aggregateHourlyAmountsByMapDay({
    rows,
    scenario: {
      start: {
        day: 1,
        hour: 15,
      },
    },
    mapDaysToReport: 2,
  });

  assert.equal(aggregated.length, 2);
  assert.equal(aggregated[0]?.mapDay, 1);
  assert.equal(aggregated[0]?.mapDayStartAbs, 0);
  assert.equal(aggregated[0]?.hoursCounted, 9);
  assert.equal(aggregated[0]?.total, 9);
  assert.equal(aggregated[1]?.mapDay, 2);
  assert.equal(aggregated[1]?.mapDayStartAbs, 24);
  assert.equal(aggregated[1]?.hoursCounted, 24);
  assert.equal(aggregated[1]?.total, 24);
});
