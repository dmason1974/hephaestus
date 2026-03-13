import test from "node:test";
import assert from "node:assert/strict";
import { BASE_RESOURCE_PRODUCTION } from "../../core/constants.js";
import {
  buildDailyMultipliersTable,
  buildDailyResourceTable,
  buildHourlyResourceBalanceTable,
  buildHourlyResourceTable,
} from "./city-production.js";
import { getEconomicBuildingEffectsForLevels } from "./building-modifiers.js";
import { buildTestBuildings } from "../../test-support/buildings-fixture.js";

test("cash is available as a resource class with base production", () => {
  assert.equal(BASE_RESOURCE_PRODUCTION.cash, 1500);
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

test("hourly resource table uses calendar midnight for morale/day ticks when startAbsoluteHour is offset", () => {
  const city = {
    resource: "supplies" as const,
    startPop: 5 as const,
    ecoInfraMultiplier: 1,
    moraleParams: { S: 70, T: 90, N: 0, D: 8 },
  };

  const hourly = buildHourlyResourceTable(2, "4x", city, {
    startAbsoluteHour: 15,
  });

  assert.equal(hourly.rows[0]?.day, 1);
  assert.equal(hourly.rows[0]?.hourOfDay, 16);
  assert.equal(hourly.rows[8]?.day, 1);
  assert.equal(hourly.rows[8]?.hourOfDay, 24);
  assert.equal(hourly.rows[9]?.day, 2);
  assert.equal(hourly.rows[9]?.hourOfDay, 1);
  assert.notEqual(hourly.rows[8]?.amount, hourly.rows[9]?.amount);
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

test("resource table applies reusable building effects for static Arms Industry levels", () => {
  const buildings = buildTestBuildings();
  const effects = getEconomicBuildingEffectsForLevels(buildings, { arms_industry: 1 });
  const baseCashCity = {
    resource: "cash" as const,
    startPop: 5 as const,
    ecoInfraMultiplier: 1,
    moraleParams: { S: 70, T: 90, N: 0, D: 8 },
  };
  const baseSuppliesCity = {
    ...baseCashCity,
    resource: "supplies" as const,
  };

  const baseHourly = buildHourlyResourceTable(1, "4x", baseCashCity);
  const improvedHourly = buildHourlyResourceTable(1, "4x", {
    ...baseCashCity,
    buildingEffects: effects,
  });
  const baseSuppliesHourly = buildHourlyResourceTable(1, "4x", baseSuppliesCity);
  const improvedSuppliesHourly = buildHourlyResourceTable(1, "4x", {
    ...baseSuppliesCity,
    buildingEffects: effects,
  });

  assert.equal(improvedHourly.rows[0]?.amount - baseHourly.rows[0]?.amount, 7);
  assert.equal(improvedSuppliesHourly.rows[0]?.amount - baseSuppliesHourly.rows[0]?.amount, 3);
});

test("city status multiplier reduces production for occupied and annexed cities", () => {
  const homeland = buildHourlyResourceTable(1, "4x", {
    resource: "supplies",
    startPop: 5,
    ecoInfraMultiplier: 1,
    moraleParams: { S: 70, T: 90, N: 0, D: 8 },
    cityStatus: "homeland",
  });
  const occupied = buildHourlyResourceTable(1, "4x", {
    resource: "supplies",
    startPop: 5,
    ecoInfraMultiplier: 1,
    moraleParams: { S: 70, T: 90, N: 0, D: 8 },
    cityStatus: "occupied",
  });
  const annexed = buildHourlyResourceTable(1, "4x", {
    resource: "supplies",
    startPop: 5,
    ecoInfraMultiplier: 1,
    moraleParams: { S: 70, T: 90, N: 0, D: 8 },
    cityStatus: "annexed",
  });

  assert.ok(homeland.rows[0].amount > occupied.rows[0].amount);
  assert.ok(annexed.rows[0].amount > occupied.rows[0].amount);
  assert.ok(homeland.rows[0].amount > annexed.rows[0].amount);
});

test("manpower applies recruiting office multiplier and flat bonus", () => {
  const buildings = buildTestBuildings();
  const baseline = buildDailyResourceTable(1, "1x", {
    resource: "manpower",
    startPop: 5,
    moraleParams: { S: 70, T: 90, N: 0, D: 8 },
  });
  const improved = buildDailyResourceTable(1, "1x", {
    resource: "manpower",
    startPop: 5,
    moraleParams: { S: 70, T: 90, N: 0, D: 8 },
    buildingEffects: getEconomicBuildingEffectsForLevels(buildings, {
      recruiting_office: 1,
    }),
  });

  assert.equal(baseline.rows[0]?.amount, 140);
  assert.equal(improved.rows[0]?.amount, 260);
});
