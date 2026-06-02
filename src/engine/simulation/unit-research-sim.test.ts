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

test("determineMaximumFeasibleLevel finds max level achievable before deadline", async () => {
  const { determineMaximumFeasibleLevel } = await import("./unit-research-sim.js");
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/ww3_2026/units/fighter_units.yml"));

  // Scenario: 28 day truce, starting day 1
  const scenario = {
    start: { day: 1, hour: 0 },
    truce_length_days: 28,
  };

  const result = determineMaximumFeasibleLevel(
    catalog,
    "air_superiority_fighter",
    scenario,
    {
      slots: 2,
    }
  );

  // Should be able to research multiple levels in 28 days
  assert.ok(result.maxLevel >= 1, "Should achieve at least level 1");
  assert.ok(result.feasible, "Should be feasible");
  assert.ok(result.level1CompletesBeforeMobilization, "Level 1 should complete before mobilization");
});

test("determineMaximumFeasibleLevel respects unlock day constraints", async () => {
  const { determineMaximumFeasibleLevel } = await import("./unit-research-sim.js");
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/ww3_2026/units/infantry_units.yml"));

  // Scenario: only 5 days available
  const scenario = {
    start: { day: 1, hour: 0 },
    truce_length_days: 5,
  };

  const result = determineMaximumFeasibleLevel(
    catalog,
    "special_forces",
    scenario,
    {
      slots: 2,
    }
  );

  // Special forces has late unlock days, so max level should be limited
  assert.ok(result.maxLevel >= 0, "Should return valid max level");
  assert.equal(result.feasible, result.maxLevel > 0, "Feasibility should match max level");
});

test("determineMaximumFeasibleLevel handles mobilization start constraint", async () => {
  const { determineMaximumFeasibleLevel } = await import("./unit-research-sim.js");
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/ww3_2026/units/fighter_units.yml"));

  const scenario = {
    start: { day: 1, hour: 0 },
    truce_length_days: 28,
  };

  // Mobilization starts at day 3 (hour 48)
  const mobilizationStartHour = 48;

  const result = determineMaximumFeasibleLevel(
    catalog,
    "air_superiority_fighter",
    scenario,
    {
      slots: 2,
      mobilizationStartHour,
    }
  );

  assert.ok(result.feasible, "Should be feasible");
  assert.ok(
    result.level1CompletesBeforeMobilization,
    "Level 1 should complete before mobilization at hour 48"
  );
});

test("determineMaximumFeasibleLevel returns infeasible when no time available", async () => {
  const { determineMaximumFeasibleLevel } = await import("./unit-research-sim.js");
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/ww3_2026/units/fighter_units.yml"));

  const scenario = {
    start: { day: 1, hour: 0 },
  };

  // Deadline is before scenario start (impossible)
  const result = determineMaximumFeasibleLevel(
    catalog,
    "air_superiority_fighter",
    scenario,
    {
      deadlineAbsoluteHour: -100,
      slots: 2,
    }
  );

  assert.equal(result.maxLevel, 0, "Should achieve no levels");
  assert.equal(result.feasible, false, "Should be infeasible");
  assert.equal(result.level1CompletesBeforeMobilization, false, "Level 1 cannot complete");
});

test("simulateUnitResearchTargets with JIT scheduling ensures level 1 before mobilization", async () => {
  const { simulateUnitResearchTargets } = await import("./unit-research-sim.js");
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/ww3_2026/units/fighter_units.yml"));

  const scenario = {
    start: { day: 1, hour: 0 },
    truce_length_days: 28,
  };

  // Mobilization starts at day 10 (hour 216)
  const mobilizationStartHour = 216;

  const result = simulateUnitResearchTargets(
    catalog,
    {
      air_superiority_fighter: 2,
    },
    scenario,
    {
      slots: 2,
      mobilizationStartHour,
      enableJitScheduling: true,
    }
  );

  // Find level 1 segment
  const level1Segment = result.segments.find(
    seg => seg.unitId === "air_superiority_fighter" && seg.level === 1
  );

  assert.ok(level1Segment, "Level 1 segment should exist");
  assert.ok(
    level1Segment.endAbsoluteHourExclusive <= mobilizationStartHour,
    `Level 1 should complete (${level1Segment.endAbsoluteHourExclusive}) before mobilization (${mobilizationStartHour})`
  );

  // Higher levels should be scheduled JIT for truce end
  const level2Segment = result.segments.find(
    seg => seg.unitId === "air_superiority_fighter" && seg.level === 2
  );

  if (level2Segment) {
    const truceEndHour = 28 * 24; // 672 hours
    assert.ok(
      level2Segment.endAbsoluteHourExclusive <= truceEndHour,
      "Level 2 should complete before truce end"
    );
  }
});

test("simulateUnitResearchTargets with JIT disabled uses standard scheduling", async () => {
  const { simulateUnitResearchTargets } = await import("./unit-research-sim.js");
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/ww3_2026/units/fighter_units.yml"));

  const scenario = {
    start: { day: 1, hour: 0 },
    truce_length_days: 28,
  };

  const mobilizationStartHour = 216;

  const result = simulateUnitResearchTargets(
    catalog,
    {
      air_superiority_fighter: 2,
    },
    scenario,
    {
      slots: 2,
      mobilizationStartHour,
      enableJitScheduling: false,
    }
  );

  // With JIT disabled, scheduling should still work but may not respect mobilization constraint
  assert.ok(result.segments.length > 0, "Should have research segments");
  assert.ok(result.totals.cash > 0, "Should have research costs");
});

test("determineMaximumFeasibleLevel handles units with no levels", async () => {
  const { determineMaximumFeasibleLevel } = await import("./unit-research-sim.js");
  
  // Create a minimal catalog with a unit that has no levels
  const catalog = {
    schema_version: 1,
    domain: "units" as const,
    resources: ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"],
    units: {
      empty_unit: {
        name: "Empty Unit",
        category: "air",
        doctrine: "none",
        levels: {},
      },
    },
  };

  const scenario = {
    start: { day: 1, hour: 0 },
    truce_length_days: 28,
  };

  const result = determineMaximumFeasibleLevel(
    catalog,
    "empty_unit",
    scenario,
    {
      slots: 2,
    }
  );

  assert.equal(result.maxLevel, 0, "Should have max level 0");
  assert.equal(result.feasible, false, "Should be infeasible");
});
