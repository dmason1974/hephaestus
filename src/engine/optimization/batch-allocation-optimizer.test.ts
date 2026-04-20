import assert from "node:assert/strict";
import test from "node:test";

import type { UnitCatalog } from "../../schemas/unit-schema.js";
import type { BuildingsFile } from "../../schemas/building-schema.js";
import {
  optimizeBatchAllocation,
  validateBatchAllocation,
  generateAlternativeBatchAllocations,
} from "./batch-allocation-optimizer.js";
import { getTotalUnitsFromBatch } from "./types.js";

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
                supplies: 150,
                components: 0,
                fuel: 0,
                rares: 0,
                electronics: 0,
                cash: 150,
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
              unlock_day: 1,
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
                supplies: 200,
                components: 0,
                fuel: 0,
                rares: 0,
                electronics: 0,
                cash: 200,
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

function buildTestBuildings(): BuildingsFile {
  return {
    schema_version: 1,
    domain: "buildings",
    resources: ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"],
    buildings: {
      recruiting_office: {
        name: "Recruiting Office",
        category: "Buildings",
        levels: {
          "1": {
            build_time: { hours: 1 },
            mobilisation_speed_bonus_pct: 0.1,
            cost: {
              supplies: 100,
              components: 50,
              fuel: 0,
              rares: 0,
              electronics: 25,
              cash: 200,
              manpower: 0,
            },
          },
          "2": undefined,
          "3": undefined,
          "4": undefined,
          "5": undefined,
        },
      },
    },
  };
}

test("optimizeBatchAllocation allocates all units to cheapest level", () => {
  const catalog = buildTestUnitCatalog();
  const buildings = buildTestBuildings();

  const result = optimizeBatchAllocation({
    unitId: "test_unit",
    totalUnits: 10,
    config: {
      cities: [{ cityId: "alpha", roLevel: 1, unitsAllocated: 10 }],
      buildingCost: 0,
    },
    researchSchedule: [
      { level: 1, startHour: 0, endHour: 2 },
      { level: 2, startHour: 2, endHour: 6 },
      { level: 3, startHour: 6, endHour: 12 },
    ],
    deadlineHour: 100,
    unitCatalog: catalog,
    buildings,
  });

  assert.equal(result.feasible, true);
  assert.equal(getTotalUnitsFromBatch(result.allocation), 10);
  
  // Level 1 should be cheapest (lower mobilization cost + longer upkeep is still cheaper)
  assert.equal(result.allocation[1], 10);
  assert.equal(result.allocation[2] ?? 0, 0);
  assert.equal(result.allocation[3] ?? 0, 0);
});

test("optimizeBatchAllocation handles single level", () => {
  const catalog = buildTestUnitCatalog();
  const buildings = buildTestBuildings();

  const result = optimizeBatchAllocation({
    unitId: "test_unit",
    totalUnits: 5,
    config: {
      cities: [{ cityId: "alpha", roLevel: 1, unitsAllocated: 5 }],
      buildingCost: 0,
    },
    researchSchedule: [{ level: 1, startHour: 0, endHour: 2 }],
    deadlineHour: 50,
    unitCatalog: catalog,
    buildings,
  });

  assert.equal(result.feasible, true);
  assert.equal(result.allocation[1], 5);
  assert.ok(result.totalCost > 0);
});

test("optimizeBatchAllocation returns infeasible when no research", () => {
  const catalog = buildTestUnitCatalog();
  const buildings = buildTestBuildings();

  const result = optimizeBatchAllocation({
    unitId: "test_unit",
    totalUnits: 10,
    config: {
      cities: [{ cityId: "alpha", roLevel: 1, unitsAllocated: 10 }],
      buildingCost: 0,
    },
    researchSchedule: [],
    deadlineHour: 100,
    unitCatalog: catalog,
    buildings,
  });

  assert.equal(result.feasible, false);
  assert.equal(result.totalCost, Number.POSITIVE_INFINITY);
});

test("optimizeBatchAllocation includes cost breakdown", () => {
  const catalog = buildTestUnitCatalog();
  const buildings = buildTestBuildings();

  const result = optimizeBatchAllocation({
    unitId: "test_unit",
    totalUnits: 10,
    config: {
      cities: [{ cityId: "alpha", roLevel: 1, unitsAllocated: 10 }],
      buildingCost: 0,
    },
    researchSchedule: [
      { level: 1, startHour: 0, endHour: 2 },
      { level: 2, startHour: 2, endHour: 6 },
    ],
    deadlineHour: 100,
    unitCatalog: catalog,
    buildings,
  });

  assert.ok(result.costBreakdown.mobilizationByLevel[1] > 0);
  assert.ok(result.costBreakdown.upkeepByLevel[1] > 0);
  
  // Total cost should equal sum of mobilization + upkeep
  const totalMob = Object.values(result.costBreakdown.mobilizationByLevel).reduce((a, b) => a + b, 0);
  const totalUpkeep = Object.values(result.costBreakdown.upkeepByLevel).reduce((a, b) => a + b, 0);
  assert.equal(result.totalCost, totalMob + totalUpkeep);
});

test("validateBatchAllocation accepts valid allocations", () => {
  const valid = validateBatchAllocation(
    { 1: 5, 2: 5 },
    10,
    [
      { level: 1, startHour: 0, endHour: 2 },
      { level: 2, startHour: 2, endHour: 6 },
    ]
  );

  assert.equal(valid, true);
});

test("validateBatchAllocation rejects wrong total", () => {
  const valid = validateBatchAllocation(
    { 1: 5, 2: 3 }, // Total is 8, not 10
    10,
    [
      { level: 1, startHour: 0, endHour: 2 },
      { level: 2, startHour: 2, endHour: 6 },
    ]
  );

  assert.equal(valid, false);
});

test("validateBatchAllocation rejects unresearched levels", () => {
  const valid = validateBatchAllocation(
    { 1: 5, 3: 5 }, // Level 3 not researched
    10,
    [
      { level: 1, startHour: 0, endHour: 2 },
      { level: 2, startHour: 2, endHour: 6 },
    ]
  );

  assert.equal(valid, false);
});

test("generateAlternativeBatchAllocations creates multiple strategies", () => {
  const catalog = buildTestUnitCatalog();
  const buildings = buildTestBuildings();

  const alternatives = generateAlternativeBatchAllocations({
    unitId: "test_unit",
    totalUnits: 10,
    config: {
      cities: [{ cityId: "alpha", roLevel: 1, unitsAllocated: 10 }],
      buildingCost: 0,
    },
    researchSchedule: [
      { level: 1, startHour: 0, endHour: 2 },
      { level: 2, startHour: 2, endHour: 6 },
      { level: 3, startHour: 6, endHour: 12 },
    ],
    deadlineHour: 100,
    unitCatalog: catalog,
    buildings,
  });

  // Should generate: all L1, all L3, even split, optimized
  assert.equal(alternatives.length, 4);
  
  // All should be feasible
  assert.ok(alternatives.every(alt => alt.feasible));
  
  // All should have correct total
  assert.ok(alternatives.every(alt => getTotalUnitsFromBatch(alt.allocation) === 10));
});

test("generateAlternativeBatchAllocations handles single level", () => {
  const catalog = buildTestUnitCatalog();
  const buildings = buildTestBuildings();

  const alternatives = generateAlternativeBatchAllocations({
    unitId: "test_unit",
    totalUnits: 10,
    config: {
      cities: [{ cityId: "alpha", roLevel: 1, unitsAllocated: 10 }],
      buildingCost: 0,
    },
    researchSchedule: [{ level: 1, startHour: 0, endHour: 2 }],
    deadlineHour: 100,
    unitCatalog: catalog,
    buildings,
  });

  // Should generate: all L1 (lowest), all L1 (highest), optimized (same as all L1)
  // Even split not applicable with single level
  assert.ok(alternatives.length >= 2);
  assert.ok(alternatives.every(alt => alt.allocation[1] === 10));
});

// Made with Bob
