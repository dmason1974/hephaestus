import assert from "node:assert/strict";
import test from "node:test";

import type { CityEcoResult } from "./city-eco-beam.js";
import { cityIncomeThroughFlip, cityFullEcoIncome } from "./city-eco-income.js";

function fakeCity(hourlyRate: number, hours: number): CityEcoResult {
  const hourlyCityProduction = Array.from({ length: hours }, () => ({
    supplies: hourlyRate,
    components: 0,
    fuel: 0,
    rares: 0,
    electronics: 0,
    cash: 0,
    manpower: 0,
  }));
  return { hourlyCityProduction } as unknown as CityEcoResult;
}

test("cityFullEcoIncome sums the entire window at a constant rate", () => {
  const city = fakeCity(10, 10);
  const total = cityFullEcoIncome(city);
  assert.equal(total.supplies, 100);
});

test("cityIncomeThroughFlip sums pre-flip hours then extrapolates flat at the flip-hour rate", () => {
  const city = fakeCity(10, 10);
  // 4 pre-flip hours (0..3) at rate 10 = 40, then 6 remaining hours at the rate
  // observed at hour 3 (10) = 60. Total = 100 (same as full income, constant rate).
  const total = cityIncomeThroughFlip(city, 4, 10);
  assert.equal(total.supplies, 100);
});

test("cityIncomeThroughFlip clamps flipRelHour to [0, hoursToSimulate]", () => {
  const city = fakeCity(10, 10);
  assert.equal(cityIncomeThroughFlip(city, -5, 10).supplies, cityFullEcoIncome(city).supplies);
  assert.equal(cityIncomeThroughFlip(city, 999, 10).supplies, cityFullEcoIncome(city).supplies);
});
