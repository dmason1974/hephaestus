import test from "node:test";
import assert from "node:assert/strict";

import {
  dayAtPopulation,
  populationAtDay,
} from "./population-model.js";
import { buildCountryHourlyResourceBalanceTable } from "./country-resource-balance.js";
import {
  DEFAULT_MULTIPLIER_BY_POP,
  buildDailyResourceTable,
  buildHourlyResourceBalanceTable,
  buildHourlyResourceTable,
  buildDailyMultipliersTable,
  marginalReturnsSchedule,
  populationMultiplierDetails,
  populationToMultiplier,
} from "./resource-table.js";

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

test("step growth still yields incremental production modifiers via progress", () => {
  const table = buildDailyMultipliersTable(10, {
    startPop: 5,
    populationMode: "step",
    moraleParams: { S: 70, T: 90, N: 0, D: 8 },
  });

  assert.equal(Number(table.rows[0].popDecimal.toFixed(1)), 5);
  assert.equal(Number(table.rows[1].popDecimal.toFixed(1)), 5.1);
  assert.equal(Number(table.rows[2].popDecimal.toFixed(1)), 5.2);
  assert.equal(Number(table.rows[0].popMul.toFixed(3)), 1);
  assert.equal(Number(table.rows[4].popMul.toFixed(3)), 1.02);
  assert.equal(Number(table.rows[9].popDecimal.toFixed(1)), 5.9);
  assert.equal(Number(table.rows[9].popMul.toFixed(3)), 1.045);
});

test("hourly resource table splits each day into 24 game hours", () => {
  const city = {
    resource: "supplies" as const,
    startPop: 5 as const,
    ecoInfraMultiplier: 1,
    moraleParams: { S: 70, T: 90, N: 0, D: 8 },
  };
  const daily = buildDailyResourceTable(2, "4x", city);
  const hourly = buildHourlyResourceTable(2, "4x", city);

  assert.equal(hourly.rows.length, 48);
  assert.equal(hourly.rows[0].hour, 1);
  assert.equal(hourly.rows[0].day, 1);
  assert.equal(hourly.rows[0].hourOfDay, 1);
  assert.equal(hourly.rows[23].hour, 24);
  assert.equal(hourly.rows[23].day, 1);
  assert.equal(hourly.rows[23].hourOfDay, 24);
  assert.equal(hourly.rows[24].hour, 25);
  assert.equal(hourly.rows[24].day, 2);
  assert.equal(hourly.rows[24].hourOfDay, 1);
  assert.equal(hourly.rows[0].amount, Math.floor(daily.rows[0].amount / 24));
  assert.equal(hourly.rows[24].amount, Math.floor(daily.rows[1].amount / 24));
  assert.equal(hourly.total, hourly.rows.reduce((sum, row) => sum + row.amount, 0));
});

test("hourly balance table carries starting balance and production only", () => {
  const city = {
    resource: "supplies" as const,
    startPop: 5 as const,
    ecoInfraMultiplier: 1,
    moraleParams: { S: 70, T: 90, N: 0, D: 8 },
  };
  const hourly = buildHourlyResourceTable(1, "4x", city);
  const balance = buildHourlyResourceBalanceTable(1, "4x", city, {
    startingBalance: 100,
  });

  assert.equal(balance.rows.length, 24);
  assert.equal(balance.rows[0].balanceStart, 100);
  assert.equal(balance.rows[0].production, Math.floor(hourly.rows[0].amount));
  assert.equal(balance.rows[0].balanceEnd, 100 + hourly.rows[0].amount);
  assert.equal(balance.rows[1].production, hourly.rows[1].amount);
  assert.equal(balance.endingBalance, 100 + hourly.total);
});

test("country hourly balance table accumulates balances per resource", () => {
  const country = {
    version: 1,
    country: {
      id: "testland",
      name: "Testland",
      doctrine: "western",
    },
    cities: [
      {
        id: "alpha",
        name: "Alpha",
        capital: true,
        resource: "supplies",
        population: 5,
        starting: {
          army_base: 1,
          air_base: 0,
          naval_base: 0,
          arms_industry: 0,
          local_industry: 0,
          recruiting_office: 0,
        },
      },
      {
        id: "bravo",
        name: "Bravo",
        capital: false,
        resource: "fuel",
        population: 4,
        starting: {
          army_base: 1,
          air_base: 0,
          naval_base: 0,
          arms_industry: 0,
          local_industry: 0,
          recruiting_office: 0,
        },
      },
    ],
  };

  const table = buildCountryHourlyResourceBalanceTable(country, 1, "4x", {
    startingBalances: {
      supplies: 100,
      fuel: 50,
    },
  });

  assert.equal(table.rows.length, 24);
  assert.equal(table.rows[0].hour, 1);
  assert.equal(table.rows[0].balances.supplies >= 100, true);
  assert.equal(table.rows[0].balances.fuel >= 50, true);
  assert.equal(table.rows[0].balances.components, undefined);
  assert.equal(
    table.endingBalances.supplies,
    table.rows[23].balances.supplies
  );
  assert.equal(
    table.endingBalances.fuel,
    table.rows[23].balances.fuel
  );
});
