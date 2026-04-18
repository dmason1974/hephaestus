import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { loadUnitCatalog } from "../../scenarios/io/load-unit-catalog.js";
import { simulateUnitResearchQueue, simulateUnitResearchTargets } from "./unit-research-sim.js";

test("unit research queue schedules chained levels on the earliest free slot", () => {
  const catalog = loadUnitCatalog(path.resolve("data/units/fighter_units.yml"));

  const result = simulateUnitResearchQueue(
    catalog,
    [{ unitId: "air_superiority_fighter", targetLevel: 2 }],
    { start: { day: 1, hour: 15 } }
  );

  assert.equal(result.segments.length, 2);
  assert.deepEqual(
    result.segments.map(segment => ({
      unitId: segment.unitId,
      level: segment.level,
      slot: segment.slot,
      startAbsoluteHour: segment.startAbsoluteHour,
      endAbsoluteHourExclusive: segment.endAbsoluteHourExclusive,
      durationHours: segment.durationHours,
    })),
    [
      {
        unitId: "air_superiority_fighter",
        level: 1,
        slot: 1,
        startAbsoluteHour: 24,
        endAbsoluteHourExclusive: 25,
        durationHours: 1,
      },
      {
        unitId: "air_superiority_fighter",
        level: 2,
        slot: 2,
        startAbsoluteHour: 72,
        endAbsoluteHourExclusive: 91,
        durationHours: 19,
      },
    ]
  );
  assert.equal(result.totals.cash, 8400);
  assert.equal(result.spendingByAbsoluteHour.length, 2);
});

test("unit research queue respects unlock day when it is later than scenario start", () => {
  const catalog = loadUnitCatalog(path.resolve("data/units/naval_units.yml"));

  const result = simulateUnitResearchQueue(
    catalog,
    [{ unitId: "naval_veteran", targetLevel: 1 }],
    { start: { day: 1, hour: 15 } }
  );

  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0]?.startAbsoluteHour, 48);
  assert.equal(result.segments[0]?.durationHours, 6);
  assert.equal(result.segments[0]?.endAbsoluteHourExclusive, 54);
});

test("unit research queue uses two country research slots by default", () => {
  const catalog = loadUnitCatalog(path.resolve("data/units/fighter_units.yml"));

  const result = simulateUnitResearchQueue(
    catalog,
    [
      { unitId: "air_superiority_fighter", targetLevel: 1 },
      { unitId: "fixed_wing_veteran", targetLevel: 1 },
    ],
    { start: { day: 1, hour: 15 } }
  );

  assert.deepEqual(
    result.segments.map(segment => ({
      unitId: segment.unitId,
      level: segment.level,
      slot: segment.slot,
      startAbsoluteHour: segment.startAbsoluteHour,
      endAbsoluteHourExclusive: segment.endAbsoluteHourExclusive,
    })),
    [
      {
        unitId: "air_superiority_fighter",
        level: 1,
        slot: 1,
        startAbsoluteHour: 24,
        endAbsoluteHourExclusive: 25,
      },
      {
        unitId: "fixed_wing_veteran",
        level: 1,
        slot: 2,
        startAbsoluteHour: 24,
        endAbsoluteHourExclusive: 30,
      },
    ]
  );
});

test("unit research queue aggregates spend by research start hour", () => {
  const catalog = loadUnitCatalog(path.resolve("data/units/seasonal_units.yml"));

  const result = simulateUnitResearchQueue(
    catalog,
    [{ unitId: "deployable_gear", targetLevel: 1 }],
    { start: { day: 1, hour: 15 } }
  );

  assert.deepEqual(result.spendingByAbsoluteHour, [
    {
      absoluteHour: 15,
      cost: {
        supplies: 0,
        components: 0,
        fuel: 0,
        rares: 0,
        electronics: 0,
        cash: 0,
        manpower: 0,
      },
    },
  ]);
});

test("unit research targets builds a two-slot plan automatically", () => {
  const catalog = loadUnitCatalog(path.resolve("data/units/fighter_units.yml"));

  const result = simulateUnitResearchTargets(
    catalog,
    {
      air_superiority_fighter: 2,
      fixed_wing_veteran: 1,
    },
    { start: { day: 1, hour: 15 } }
  );

  assert.deepEqual(
    result.segments.map(segment => ({
      unitId: segment.unitId,
      level: segment.level,
      slot: segment.slot,
      startAbsoluteHour: segment.startAbsoluteHour,
      endAbsoluteHourExclusive: segment.endAbsoluteHourExclusive,
    })),
    [
      {
        unitId: "air_superiority_fighter",
        level: 1,
        slot: 1,
        startAbsoluteHour: 24,
        endAbsoluteHourExclusive: 25,
      },
      {
        unitId: "fixed_wing_veteran",
        level: 1,
        slot: 2,
        startAbsoluteHour: 24,
        endAbsoluteHourExclusive: 30,
      },
      {
        unitId: "air_superiority_fighter",
        level: 2,
        slot: 1,
        startAbsoluteHour: 72,
        endAbsoluteHourExclusive: 91,
      },
    ]
  );
});

test("unit research targets auto-includes cross-file unit prerequisites when catalogs are merged", () => {
  const navalCatalog = loadUnitCatalog(path.resolve("data/units/naval_units.yml"));
  const seasonalCatalog = loadUnitCatalog(path.resolve("data/units/seasonal_units.yml"));
  const catalog = {
    ...navalCatalog,
    units: {
      ...navalCatalog.units,
      ...seasonalCatalog.units,
    },
  };

  const result = simulateUnitResearchTargets(
    catalog,
    {
      elite_frigate: 1,
    },
    { start: { day: 1, hour: 15 } }
  );

  assert.deepEqual(
    result.segments.map(segment => ({
      unitId: segment.unitId,
      level: segment.level,
      startAbsoluteHour: segment.startAbsoluteHour,
      endAbsoluteHourExclusive: segment.endAbsoluteHourExclusive,
    })),
    [
      {
        unitId: "frigate",
        level: 1,
        startAbsoluteHour: 48,
        endAbsoluteHourExclusive: 69,
      },
      {
        unitId: "elite_frigate",
        level: 1,
        startAbsoluteHour: 72,
        endAbsoluteHourExclusive: 93,
      },
    ]
  );
});

test("unit research targets waits for prerequisite unit completion", () => {
  const navalCatalog = loadUnitCatalog(path.resolve("data/units/naval_units.yml"));
  const seasonalCatalog = loadUnitCatalog(path.resolve("data/units/seasonal_units.yml"));
  const mergedCatalog = {
    ...navalCatalog,
    units: {
      ...navalCatalog.units,
      ...seasonalCatalog.units,
    },
  };

  const result = simulateUnitResearchTargets(
    mergedCatalog,
    {
      elite_frigate: 1,
    },
    { start: { day: 1, hour: 15 } }
  );

  assert.equal(result.segments[0]?.unitId, "frigate");
  assert.equal(result.segments[0]?.endAbsoluteHourExclusive, 69);
  assert.equal(result.segments[1]?.unitId, "elite_frigate");
  assert.equal(result.segments[1]?.startAbsoluteHour, 72);
});

test("unit research queue treats unlock days through the scenario offset as available at start", () => {
  const catalog = loadUnitCatalog(path.resolve("data/units/fighter_units.yml"));

  const result = simulateUnitResearchQueue(
    catalog,
    [{ unitId: "air_superiority_fighter", targetLevel: 2 }],
    {
      start: { day: 1, hour: 15 },
      research: { unlocked_through_day_at_start: 9 },
    }
  );

  assert.equal(result.segments[0]?.startAbsoluteHour, 15);
  assert.equal(result.segments[1]?.startAbsoluteHour, 15);
});

test("unit research queue shifts later unlock days forward by the scenario offset", () => {
  const catalog = loadUnitCatalog(path.resolve("data/units/infantry_units.yml"));

  const result = simulateUnitResearchQueue(
    catalog,
    [{ unitId: "special_forces", targetLevel: 5 }],
    {
      start: { day: 1, hour: 15 },
      research: { unlocked_through_day_at_start: 10 },
    }
  );

  assert.equal(result.segments[4]?.level, 5);
  assert.equal(result.segments[4]?.startAbsoluteHour, 480);
});
