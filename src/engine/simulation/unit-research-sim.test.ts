import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { loadUnitCatalog } from "../../scenarios/io/load-unit-catalog.js";
import { simulateUnitResearchQueue, simulateUnitResearchTargets } from "./unit-research-sim.js";

test("unit research queue schedules chained levels on the earliest free slot", () => {
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/standard/units/fighter_units.yml"));

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
        startAbsoluteHour: 15,
        endAbsoluteHourExclusive: 16,
        durationHours: 1,
      },
      {
        unitId: "air_superiority_fighter",
        level: 2,
        slot: 2,
        startAbsoluteHour: 48,
        endAbsoluteHourExclusive: 49,
        durationHours: 1,
      },
    ]
  );
  assert.equal(result.totals.cash, 8400);
  assert.equal(result.spendingByAbsoluteHour.length, 2);
});

test("unit research queue respects unlock day when it is later than scenario start", () => {
  // special_forces has unlock_day 4 — must not start before day 4 hour 0 (absoluteHour 72)
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/standard/units/infantry_units.yml"));

  const result = simulateUnitResearchQueue(
    catalog,
    [{ unitId: "special_forces", targetLevel: 1 }],
    { start: { day: 1, hour: 15 } }
  );

  assert.equal(result.segments.length, 1);
  // Unlock day 4 → absoluteHour (4-1)*24 = 72; start must be >= 72
  assert.ok(result.segments[0]!.startAbsoluteHour >= 72, "Research should not start before unlock day");
});

test("unit research queue uses two country research slots by default", () => {
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/elite/units/fighter_units.yml"));

  const result = simulateUnitResearchQueue(
    catalog,
    [
      { unitId: "air_superiority_fighter", targetLevel: 1 },
      { unitId: "fixed_wing_veteran", targetLevel: 1 },
    ],
    { start: { day: 1, hour: 15 } }
  );

  assert.equal(result.segments.length, 2);
  // Units run in parallel on separate slots
  const asfSeg = result.segments.find(s => s.unitId === "air_superiority_fighter");
  const fwvSeg = result.segments.find(s => s.unitId === "fixed_wing_veteran");
  assert.ok(asfSeg, "ASF segment should exist");
  assert.ok(fwvSeg, "FWV segment should exist");
  assert.notEqual(asfSeg.slot, fwvSeg.slot, "Units should be on different research slots");
});

test("unit research queue aggregates spend by research start hour", () => {
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/elite/units/seasonal_units.yml"));

  const result = simulateUnitResearchQueue(
    catalog,
    [{ unitId: "deployable_gear", targetLevel: 1 }],
    { start: { day: 1, hour: 15 } }
  );

  assert.equal(result.segments.length, 1, "Should have one research segment");
  assert.equal(result.spendingByAbsoluteHour.length, 1, "Should have one spending entry per research hour");
  assert.ok(
    result.spendingByAbsoluteHour[0]?.absoluteHour === result.segments[0]?.startAbsoluteHour,
    "Spending should be recorded at research start hour"
  );
});

test("unit research targets builds a two-slot plan automatically", () => {
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/elite/units/fighter_units.yml"));

  // Use western doctrine: both ASF (unlock_day 1) and FWV (unlock_day 1) start immediately,
  // so the scheduler must use two parallel slots to keep both in-progress simultaneously.
  const result = simulateUnitResearchTargets(
    catalog,
    {
      air_superiority_fighter: 2,
      fixed_wing_veteran: 1,
    },
    { start: { day: 1, hour: 15 } },
    { doctrine: "western" }
  );

  // Should produce 3 segments: ASF L1, ASF L2, FWV L1
  assert.equal(result.segments.length, 3, "Should have 3 research segments");
  const unitIds = result.segments.map(s => s.unitId);
  assert.equal(unitIds.filter(id => id === "air_superiority_fighter").length, 2, "Should have 2 ASF segments");
  assert.equal(unitIds.filter(id => id === "fixed_wing_veteran").length, 1, "Should have 1 FWV segment");
  // Both units unlock on day 1, so both can start immediately — two slots must be used
  const slots = new Set(result.segments.map(s => s.slot));
  assert.equal(slots.size, 2, "Should use both research slots when multiple units unlock simultaneously");
});

test("unit research targets auto-includes cross-unit prerequisites — stealth ASF requires ASF L1-L4 first", () => {
  // Both units are in the same file; SASF requires air_superiority_fighter level 4.
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/elite/units/fighter_units.yml"));

  const result = simulateUnitResearchTargets(
    catalog,
    { stealth_air_superiority_fighter: 1 },
    { start: { day: 1, hour: 15 } }
  );

  const unitIds = new Set(result.segments.map(s => s.unitId));
  assert.ok(unitIds.has("air_superiority_fighter"), "Should auto-include ASF as prerequisite");
  assert.ok(unitIds.has("stealth_air_superiority_fighter"), "Should include SASF");

  const asfLevels = result.segments
    .filter(s => s.unitId === "air_superiority_fighter")
    .map(s => s.level)
    .sort((a, b) => a - b);
  assert.ok(asfLevels.includes(1), "Should include ASF L1");
  assert.ok(asfLevels.includes(4), "Should include ASF L4 (direct prereq of SASF)");
});

test("unit research targets waits for prerequisite unit completion before scheduling the dependent unit", () => {
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/elite/units/fighter_units.yml"));

  const result = simulateUnitResearchTargets(
    catalog,
    { stealth_air_superiority_fighter: 1 },
    { start: { day: 1, hour: 15 } }
  );

  const asfL4 = result.segments.find(s => s.unitId === "air_superiority_fighter" && s.level === 4);
  const sasfL1 = result.segments.find(s => s.unitId === "stealth_air_superiority_fighter" && s.level === 1);

  assert.ok(asfL4, "ASF L4 should be scheduled");
  assert.ok(sasfL1, "SASF L1 should be scheduled");
  assert.ok(
    asfL4.endAbsoluteHourExclusive <= sasfL1.startAbsoluteHour,
    `ASF L4 (ends ${asfL4.endAbsoluteHourExclusive}) should complete before SASF L1 starts (${sasfL1.startAbsoluteHour})`
  );
});

test("unit research queue treats unlock days through the scenario offset as available at start", () => {
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/standard/units/fighter_units.yml"));

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
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/standard/units/infantry_units.yml"));

  const result = simulateUnitResearchQueue(
    catalog,
    [{ unitId: "special_forces", targetLevel: 5 }],
    {
      start: { day: 1, hour: 15 },
      research: { unlocked_through_day_at_start: 10 },
    }
  );

  assert.equal(result.segments[4]?.level, 5);
  assert.equal(result.segments[4]?.startAbsoluteHour, 312);
});

test("determineMaximumFeasibleLevel finds max level achievable before deadline", async () => {
  const { determineMaximumFeasibleLevel } = await import("./unit-research-sim.js");
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/standard/units/fighter_units.yml"));

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
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/standard/units/infantry_units.yml"));

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
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/standard/units/fighter_units.yml"));

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
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/standard/units/fighter_units.yml"));

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
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/standard/units/fighter_units.yml"));

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
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/standard/units/fighter_units.yml"));

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

test("simulateUnitResearchTargets bufferHours reserves idle slot time before every level 2+ task", () => {
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/standard/units/fighter_units.yml"));
  const scenario = { start: { day: 1, hour: 0 }, truce_length_days: 60 };

  const result = simulateUnitResearchTargets(
    catalog,
    { air_superiority_fighter: 4, stealth_air_superiority_fighter: 1 },
    scenario,
    { slots: 2, enableJitScheduling: true, bufferHours: 24 }
  );

  const bySlot = new Map<number, typeof result.segments>();
  for (const segment of result.segments) {
    if (!bySlot.has(segment.slot)) bySlot.set(segment.slot, []);
    bySlot.get(segment.slot)!.push(segment);
  }

  for (const segments of bySlot.values()) {
    segments.sort((a, b) => a.startAbsoluteHour - b.startAbsoluteHour);
    for (let i = 1; i < segments.length; i++) {
      if (segments[i].level < 2) continue;
      const gap = segments[i].startAbsoluteHour - segments[i - 1].endAbsoluteHourExclusive;
      assert.ok(
        gap >= 24,
        `expected >=24h gap before ${segments[i].unitId} L${segments[i].level}, got ${gap}h`
      );
    }
  }
});

test("simulateUnitResearchTargets with bufferHours omitted preserves zero-margin packing", () => {
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/standard/units/fighter_units.yml"));
  const scenario = { start: { day: 1, hour: 0 }, truce_length_days: 60 };

  const result = simulateUnitResearchTargets(
    catalog,
    { air_superiority_fighter: 4, stealth_air_superiority_fighter: 1 },
    scenario,
    { slots: 2, enableJitScheduling: true }
  );

  const bySlot = new Map<number, typeof result.segments>();
  for (const segment of result.segments) {
    if (!bySlot.has(segment.slot)) bySlot.set(segment.slot, []);
    bySlot.get(segment.slot)!.push(segment);
  }

  let sawZeroGapLevel2Plus = false;
  for (const segments of bySlot.values()) {
    segments.sort((a, b) => a.startAbsoluteHour - b.startAbsoluteHour);
    for (let i = 1; i < segments.length; i++) {
      if (segments[i].level < 2) continue;
      const gap = segments[i].startAbsoluteHour - segments[i - 1].endAbsoluteHourExclusive;
      if (gap === 0) sawZeroGapLevel2Plus = true;
    }
  }
  assert.ok(sawZeroGapLevel2Plus, "expected at least one zero-gap level 2+ transition when bufferHours is omitted (every existing caller's behavior)");
});

test("simulateUnitResearchTargets bufferHours never affects level 1 placement", () => {
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/standard/units/fighter_units.yml"));
  const scenario = { start: { day: 1, hour: 0 }, truce_length_days: 60 };
  const opts = { slots: 2, enableJitScheduling: true, mobilizationStartHour: 1400 };

  const withoutBuffer = simulateUnitResearchTargets(catalog, { air_superiority_fighter: 1 }, scenario, opts);
  const withBuffer = simulateUnitResearchTargets(catalog, { air_superiority_fighter: 1 }, scenario, { ...opts, bufferHours: 24 });

  assert.deepEqual(withBuffer.segments, withoutBuffer.segments, "level 1 placement must be identical regardless of bufferHours");
});

test("simulateUnitResearchTargets noBufferTaskIds exempts specific level 2+ tasks from the buffer", () => {
  const catalog = loadUnitCatalog(path.resolve("data/scenarios/standard/units/fighter_units.yml"));
  const scenario = { start: { day: 1, hour: 0 }, truce_length_days: 60 };
  const targets = { air_superiority_fighter: 4, stealth_air_superiority_fighter: 1 };

  const buffered = simulateUnitResearchTargets(catalog, targets, scenario, { slots: 2, enableJitScheduling: true, bufferHours: 24 });
  const exempted = simulateUnitResearchTargets(catalog, targets, scenario, {
    slots: 2,
    enableJitScheduling: true,
    bufferHours: 24,
    noBufferTaskIds: new Set(["air_superiority_fighter:3"]),
  });

  const level1Buffered = buffered.segments.find(s => s.unitId === "air_superiority_fighter" && s.level === 1);
  const level1Exempted = exempted.segments.find(s => s.unitId === "air_superiority_fighter" && s.level === 1);
  assert.ok(level1Buffered && level1Exempted, "level 1 segment should exist in both runs");

  // Exempting L3 removes the 24h reservation immediately before it, letting L1
  // (which shares L3's slot) push later — a smaller gap than the buffered run.
  assert.ok(
    level1Exempted!.endAbsoluteHourExclusive > level1Buffered!.endAbsoluteHourExclusive,
    "exempting L3 should let L1 (same slot) schedule later than the fully-buffered run"
  );
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
