import test from "node:test";
import assert from "node:assert/strict";
import {
  dayAtPopulation,
  populationAtDay,
} from "./population.js";
import {
  DEFAULT_MULTIPLIER_BY_POP,
  marginalReturnsSchedule,
  populationMultiplierDetails,
  populationToManpower,
  populationToMultiplier,
} from "./city-production.js";

test("step mode uses exact 1-based threshold days for startPop 4", () => {
  const expected = new Map([
    [1, 4],
    [6, 5],
    [16, 6],
    [31, 7],
    [56, 8],
    [91, 9],
    [136, 10],
  ]);

  for (const [day, pop] of expected) {
    assert.equal(populationAtDay(day, 4, "step").popInt, pop);
    assert.equal(dayAtPopulation(pop, 4, "step"), day);
  }
});

test("step mode shifts thresholds correctly for startPop 5", () => {
  assert.equal(populationAtDay(1, 5, "step").popInt, 5);
  assert.equal(populationAtDay(10, 5, "step").popInt, 5);
  assert.equal(populationAtDay(11, 5, "step").popInt, 6);
  assert.equal(dayAtPopulation(6, 5, "step"), 11);
  assert.equal(dayAtPopulation(7, 5, "step"), 26);
  assert.equal(dayAtPopulation(10, 5, "step"), 131);
});

test("step mode shifts thresholds correctly for startPop 6", () => {
  assert.equal(populationAtDay(1, 6, "step").popInt, 6);
  assert.equal(populationAtDay(15, 6, "step").popInt, 6);
  assert.equal(populationAtDay(16, 6, "step").popInt, 7);
  assert.equal(dayAtPopulation(7, 6, "step"), 16);
  assert.equal(dayAtPopulation(8, 6, "step"), 41);
  assert.equal(dayAtPopulation(10, 6, "step"), 121);
});

test("smooth mode remains close to canonical threshold days", () => {
  const targets = [
    { pop: 5, exactDay: 6 },
    { pop: 6, exactDay: 16 },
    { pop: 7, exactDay: 31 },
    { pop: 8, exactDay: 56 },
    { pop: 9, exactDay: 91 },
    { pop: 10, exactDay: 136 },
  ];

  for (const { pop, exactDay } of targets) {
    const smoothDay = dayAtPopulation(pop, 4, "smooth");
    assert.ok(Math.abs(smoothDay - exactDay) <= 7, `expected pop ${pop} smooth day ${smoothDay} near ${exactDay}`);
  }
});

test("smooth mode uses t = day - 1 and returns both float and int populations", () => {
  const day1 = populationAtDay(1, 4, "smooth");
  assert.equal(day1.popInt, 4);
  assert.equal(day1.popFloat, 4);
  assert.equal(day1.progressToNext, 0);

  const day6 = populationAtDay(6, 4, "smooth");
  assert.equal(day6.popInt, 5);
  assert.ok((day6.popFloat ?? 0) >= 5);
});

test("population multiplier details and marginal schedule use tier durations", () => {
  const details = populationMultiplierDetails(7, DEFAULT_MULTIPLIER_BY_POP);
  assert.equal(details.multiplier, 1.1);
  assert.equal(Number(details.incrementalGain.toFixed(2)), 0.05);
  assert.equal(details.daysToNextPop, 25);
  assert.equal(Number(details.marginalGainPerDay.toFixed(3)), 0.002);

  const schedule = marginalReturnsSchedule(4, 40, DEFAULT_MULTIPLIER_BY_POP);
  assert.deepEqual(schedule.slice(0, 3), [
    {
      popFrom: 4,
      popTo: 5,
      dayStartInclusive: 1,
      dayEndExclusive: 6,
      durationDays: 5,
      multiplierFrom: 0.8,
      multiplierTo: 1,
      incrementalGain: 0.19999999999999996,
      marginalGainPerDay: 0.039999999999999994,
    },
    {
      popFrom: 5,
      popTo: 6,
      dayStartInclusive: 6,
      dayEndExclusive: 16,
      durationDays: 10,
      multiplierFrom: 1,
      multiplierTo: 1.05,
      incrementalGain: 0.050000000000000044,
      marginalGainPerDay: 0.0050000000000000044,
    },
    {
      popFrom: 6,
      popTo: 7,
      dayStartInclusive: 16,
      dayEndExclusive: 31,
      durationDays: 15,
      multiplierFrom: 1.05,
      multiplierTo: 1.1,
      incrementalGain: 0.050000000000000044,
      marginalGainPerDay: 0.003333333333333336,
    },
  ]);
});

test("population modifier interpolates incrementally within a tier", () => {
  assert.equal(populationToMultiplier(5.5, DEFAULT_MULTIPLIER_BY_POP), 1.025);
  assert.equal(populationToMultiplier(5, DEFAULT_MULTIPLIER_BY_POP), 1);
  assert.equal(populationToMultiplier(6, DEFAULT_MULTIPLIER_BY_POP), 1.05);
});

test("manpower is derived from population", () => {
  assert.equal(populationToManpower(4), 125);
  assert.equal(populationToManpower(5), 140);
  assert.equal(populationToManpower(5.5), 145);
  assert.equal(populationToManpower(10), 200);
});
