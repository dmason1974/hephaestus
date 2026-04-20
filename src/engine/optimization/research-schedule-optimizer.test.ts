import assert from "node:assert/strict";
import test from "node:test";

import type { UnitCatalog } from "../../schemas/unit-schema.js";
import type { ScenarioFile } from "../../schemas/scenario-schema.js";
import { optimizeResearchSchedule, validateResearchSchedule } from "./research-schedule-optimizer.js";

function buildTestUnitCatalog(): UnitCatalog {
  return {
    schema_version: 1,
    domain: "units",
    resources: ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"],
    units: {
      test_unit: {
        name: "Test Unit",
        category: "Fighter",
        doctrine: "western",
        levels: {
          "1": {
            requirements: ["air_base level 1"],
            research: {
              unlock_day: 1,
              time: { hours: 2 },
              cost: {
                supplies: 0,
                components: 0,
                fuel: 0,
                rares: 0,
                electronics: 0,
                cash: 100,
                manpower: 0,
              },
            },
            mobilisation: {
              time: { hours: 10 },
              cost: {
                supplies: 100,
                components: 0,
                fuel: 0,
                rares: 0,
                electronics: 0,
                cash: 100,
                manpower: 0,
              },
            },
            daily_upkeep: {
              cost: {
                supplies: 0,
                components: 0,
                fuel: 0,
                rares: 0,
                electronics: 0,
                cash: 10,
                manpower: 0,
              },
            },
          },
          "2": {
            requirements: ["air_base level 1", "test_unit level 1"],
            research: {
              unlock_day: 1,
              time: { hours: 4 },
              cost: {
                supplies: 0,
                components: 0,
                fuel: 0,
                rares: 0,
                electronics: 0,
                cash: 200,
                manpower: 0,
              },
            },
            mobilisation: {
              time: { hours: 12 },
              cost: {
                supplies: 120,
                components: 0,
                fuel: 0,
                rares: 0,
                electronics: 0,
                cash: 120,
                manpower: 0,
              },
            },
            daily_upkeep: {
              cost: {
                supplies: 0,
                components: 0,
                fuel: 0,
                rares: 0,
                electronics: 0,
                cash: 15,
                manpower: 0,
              },
            },
          },
          "3": {
            requirements: ["air_base level 2", "test_unit level 2"],
            research: {
              unlock_day: 5,
              time: { hours: 6 },
              cost: {
                supplies: 0,
                components: 0,
                fuel: 0,
                rares: 0,
                electronics: 0,
                cash: 300,
                manpower: 0,
              },
            },
            mobilisation: {
              time: { hours: 14 },
              cost: {
                supplies: 140,
                components: 0,
                fuel: 0,
                rares: 0,
                electronics: 0,
                cash: 140,
                manpower: 0,
              },
            },
            daily_upkeep: {
              cost: {
                supplies: 0,
                components: 0,
                fuel: 0,
                rares: 0,
                electronics: 0,
                cash: 20,
                manpower: 0,
              },
            },
          },
        },
      },
    },
  };
}

function buildTestScenario(): ScenarioFile {
  return {
    schema_version: 1,
    domain: "scenario",
    id: "test",
    name: "Test Scenario",
    start: {
      day: 1,
      hour: 0,
    },
    speed: "1x",
    starting_balance: {
      supplies: 10000,
      components: 10000,
      fuel: 10000,
      rares: 10000,
      electronics: 10000,
      cash: 100000,
      manpower: 10000,
    },
  };
}

test("optimizeResearchSchedule researches all levels when deadline allows", () => {
  const catalog = buildTestUnitCatalog();
  const scenario = buildTestScenario();

  const result = optimizeResearchSchedule({
    unitId: "test_unit",
    unitCatalog: catalog,
    scenario,
    deadlineHour: 200, // Plenty of time
    researchSlots: 2,
  });

  assert.equal(result.maxLevelAchievable, 3);
  assert.equal(result.feasible, true);
  assert.equal(result.schedule.length, 3);
  
  // Level 1: starts at hour 0, takes 2 hours
  assert.deepEqual(result.schedule[0], {
    level: 1,
    startHour: 0,
    endHour: 2,
  });
  
  // Level 2: starts at hour 2 (after L1), takes 4 hours
  assert.deepEqual(result.schedule[1], {
    level: 2,
    startHour: 2,
    endHour: 6,
  });
  
  // Level 3: starts at hour 96 (day 5), takes 6 hours
  assert.deepEqual(result.schedule[2], {
    level: 3,
    startHour: 96, // Day 5 = (5-1)*24 = 96
    endHour: 102,
  });
});

test("optimizeResearchSchedule stops when deadline is tight", () => {
  const catalog = buildTestUnitCatalog();
  const scenario = buildTestScenario();

  const result = optimizeResearchSchedule({
    unitId: "test_unit",
    unitCatalog: catalog,
    scenario,
    deadlineHour: 10, // Only enough time for L1 and L2
    researchSlots: 2,
  });

  assert.equal(result.maxLevelAchievable, 2);
  assert.equal(result.feasible, true);
  assert.equal(result.schedule.length, 2);
});

test("optimizeResearchSchedule respects unlock day constraints", () => {
  const catalog = buildTestUnitCatalog();
  const scenario = buildTestScenario();

  const result = optimizeResearchSchedule({
    unitId: "test_unit",
    unitCatalog: catalog,
    scenario,
    deadlineHour: 100, // Before L3 unlock day + research time
    researchSlots: 2,
  });

  // Can research L1 and L2, but L3 unlocks at day 5 (hour 96) and takes 6 hours (ends at 102)
  assert.equal(result.maxLevelAchievable, 2);
  assert.equal(result.schedule.length, 2);
});

test("optimizeResearchSchedule uses multiple research slots in parallel", () => {
  const catalog: UnitCatalog = {
    schema_version: 1,
    domain: "units",
    resources: ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"],
    units: {
      unit_a: {
        name: "Unit A",
        category: "Fighter",
        doctrine: "western",
        levels: {
          "1": {
            requirements: [],
            research: {
              unlock_day: 1,
              time: { hours: 10 },
              cost: {
                supplies: 0,
                components: 0,
                fuel: 0,
                rares: 0,
                electronics: 0,
                cash: 100,
                manpower: 0,
              },
            },
            mobilisation: { time: { hours: 1 }, cost: { supplies: 0, components: 0, fuel: 0, rares: 0, electronics: 0, cash: 0, manpower: 0 } },
            daily_upkeep: { cost: { supplies: 0, components: 0, fuel: 0, rares: 0, electronics: 0, cash: 0, manpower: 0 } },
          },
        },
      },
    },
  };

  const scenario = buildTestScenario();

  const result = optimizeResearchSchedule({
    unitId: "unit_a",
    unitCatalog: catalog,
    scenario,
    deadlineHour: 100,
    researchSlots: 2,
  });

  assert.equal(result.maxLevelAchievable, 1);
  assert.equal(result.totalResearchHours, 10);
});

test("validateResearchSchedule accepts valid schedules", () => {
  const catalog = buildTestUnitCatalog();
  const scenario = buildTestScenario();

  const schedule = [
    { level: 1, startHour: 0, endHour: 2 },
    { level: 2, startHour: 2, endHour: 6 },
  ];

  const valid = validateResearchSchedule(schedule, {
    unitId: "test_unit",
    unitCatalog: catalog,
    scenario,
    deadlineHour: 100,
    researchSlots: 2,
  });

  assert.equal(valid, true);
});

test("validateResearchSchedule rejects schedules that violate unlock day", () => {
  const catalog = buildTestUnitCatalog();
  const scenario = buildTestScenario();

  const schedule = [
    { level: 1, startHour: 0, endHour: 2 },
    { level: 2, startHour: 2, endHour: 6 },
    { level: 3, startHour: 10, endHour: 16 }, // Too early! Unlocks at day 5 (hour 96)
  ];

  const valid = validateResearchSchedule(schedule, {
    unitId: "test_unit",
    unitCatalog: catalog,
    scenario,
    deadlineHour: 200,
    researchSlots: 2,
  });

  assert.equal(valid, false);
});

test("validateResearchSchedule rejects schedules that exceed deadline", () => {
  const catalog = buildTestUnitCatalog();
  const scenario = buildTestScenario();

  const schedule = [
    { level: 1, startHour: 0, endHour: 2 },
    { level: 2, startHour: 2, endHour: 6 },
    { level: 3, startHour: 96, endHour: 102 },
  ];

  const valid = validateResearchSchedule(schedule, {
    unitId: "test_unit",
    unitCatalog: catalog,
    scenario,
    deadlineHour: 100, // L3 ends at 102
    researchSlots: 2,
  });

  assert.equal(valid, false);
});

test("validateResearchSchedule rejects schedules with too many parallel researches", () => {
  const catalog = buildTestUnitCatalog();
  const scenario = buildTestScenario();

  const schedule = [
    { level: 1, startHour: 0, endHour: 10 },
    { level: 2, startHour: 0, endHour: 10 }, // Parallel with L1
    { level: 3, startHour: 0, endHour: 10 }, // Also parallel - exceeds 2 slots!
  ];

  const valid = validateResearchSchedule(schedule, {
    unitId: "test_unit",
    unitCatalog: catalog,
    scenario,
    deadlineHour: 200,
    researchSlots: 2,
  });

  assert.equal(valid, false);
});

// Made with Bob
