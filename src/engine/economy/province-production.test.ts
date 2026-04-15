import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDailyProvinceResourceTable,
  buildHourlyProvinceResourceTable,
} from "./province-production.js";
import { buildTestBuildings } from "../../test-support/buildings-fixture.js";

test("province production uses province counts with morale and speed but no population modifier", () => {
  const dailySupplies = buildDailyProvinceResourceTable(1, "4x", {
    resource: "supplies",
    provinceCount: 1,
    moraleParams: { S: 70, T: 90, N: 0, D: 13 },
  });
  const dailyCash = buildDailyProvinceResourceTable(1, "4x", {
    resource: "cash",
    provinceCount: 10,
    moraleParams: { S: 70, T: 90, N: 0, D: 13 },
  });
  const dailyManpower = buildDailyProvinceResourceTable(1, "4x", {
    resource: "manpower",
    provinceCount: 10,
    moraleParams: { S: 70, T: 90, N: 0, D: 13 },
  });

  assert.equal(dailySupplies.rows[0]?.amount, 127);
  assert.equal(dailyCash.rows[0]?.amount, 911);
  assert.equal(dailyManpower.rows[0]?.amount, 72);
});

test("hourly province production is derived from floored daily province production", () => {
  const hourly = buildHourlyProvinceResourceTable(1, "4x", {
    resource: "supplies",
    provinceCount: 1,
    moraleParams: { S: 70, T: 90, N: 0, D: 13 },
  });

  assert.equal(hourly.rows.length, 24);
  assert.equal(hourly.rows[0]?.amount, 5);
  assert.equal(hourly.total, 120);
});

test("local industry increases province resource output but not province cash", () => {
  const buildings = buildTestBuildings();
  const suppliesBase = buildDailyProvinceResourceTable(1, "4x", {
    resource: "supplies",
    provinceCount: 1,
    moraleParams: { S: 70, T: 90, N: 0, D: 13 },
  });
  const suppliesImproved = buildDailyProvinceResourceTable(1, "4x", {
    resource: "supplies",
    provinceCount: 1,
    moraleParams: { S: 70, T: 90, N: 0, D: 13 },
    buildingsFile: buildings,
    localIndustryLevel: 1,
  });
  const cashBase = buildDailyProvinceResourceTable(1, "4x", {
    resource: "cash",
    provinceCount: 1,
    moraleParams: { S: 70, T: 90, N: 0, D: 13 },
  });
  const cashImproved = buildDailyProvinceResourceTable(1, "4x", {
    resource: "cash",
    provinceCount: 1,
    moraleParams: { S: 70, T: 90, N: 0, D: 13 },
    buildingsFile: buildings,
    localIndustryLevel: 1,
  });

  assert.equal(suppliesBase.rows[0]?.amount, 127);
  assert.equal(suppliesImproved.rows[0]?.amount, 191);
  assert.equal(cashBase.rows[0]?.amount, 91);
  assert.equal(cashImproved.rows[0]?.amount, 91);
});

test("combat outpost improves province morale and therefore province production", () => {
  const buildings = buildTestBuildings();
  const base = buildDailyProvinceResourceTable(3, "4x", {
    resource: "cash",
    provinceCount: 10,
    moraleParams: { S: 70, T: 90, N: 0, D: 13 },
  });
  const improved = buildDailyProvinceResourceTable(3, "4x", {
    resource: "cash",
    provinceCount: 10,
    moraleParams: { S: 70, T: 90, N: 0, D: 13 },
    buildingsFile: buildings,
    combatOutpostLevel: 1,
  });

  assert.ok(improved.rows[2].amount > base.rows[2].amount);
});
