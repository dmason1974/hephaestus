import assert from "node:assert/strict";
import test from "node:test";

import type { BuildingsFile } from "../../schemas/building-schema.js";
import type { UnitCatalog } from "../../schemas/unit-schema.js";
import {
  calculateBuildingCost,
  calculateCompletionHour,
  calculateMobilizationCost,
  calculateMobilizationDuration,
  calculateTotalCost,
  calculateUpkeepCost,
  resourceCostToScalar,
} from "./cost-calculator.js";

function buildTestUnitCatalog(): UnitCatalog {
  return {
    schema_version: 1,
    domain: "units",
    resources: ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"],
    units: {
      strike_fighter: {
        name: "Strike Fighter",
        category: "Fighter",
        doctrine: ["western"],
        levels: {
          "1": {
            requirements: ["air_base level 1", "recruiting_office level 1"],
            research: {
              western: {
                unlock_day: 1,
                time: { hours: 1 },
                cost: {
                  supplies: 10,
                  components: 20,
                  rares: 5,
                  electronics: 30,
                  cash: 100,
                },
              },
            },
            mobilisation: {
              western: {
                time: { hours: 10 },
                cost: {
                  supplies: 100,
                  components: 50,
                  fuel: 25,
                  electronics: 10,
                  cash: 200,
                  manpower: 5,
                },
              },
            },
            daily_upkeep: {
              western: {
                cost: {
                  fuel: 24,
                  cash: 48,
                },
              },
            },
          },
          "2": {
            requirements: ["air_base level 1", "recruiting_office level 2", "strike_fighter level 1"],
            research: {
              western: {
                unlock_day: 1,
                time: { hours: 2 },
                cost: {
                  supplies: 10,
                  components: 20,
                  rares: 5,
                  electronics: 30,
                  cash: 100,
                },
              },
            },
            mobilisation: {
              western: {
                time: { hours: 12 },
                cost: {
                  supplies: 120,
                  components: 60,
                  fuel: 30,
                  electronics: 15,
                  cash: 240,
                  manpower: 6,
                },
              },
            },
            daily_upkeep: {
              western: {
                cost: {
                  fuel: 36,
                  cash: 72,
                },
              },
            },
          },
          "3": {
            requirements: ["air_base level 2", "recruiting_office level 2", "strike_fighter level 2"],
            research: {
              western: {
                unlock_day: 1,
                time: { hours: 3 },
                cost: {
                  supplies: 10,
                  components: 20,
                  rares: 5,
                  electronics: 30,
                  cash: 100,
                },
              },
            },
            mobilisation: {
              western: {
                time: { hours: 13 },
                cost: {
                  supplies: 130,
                  components: 65,
                  fuel: 32,
                  electronics: 18,
                  cash: 260,
                  manpower: 6,
                },
              },
            },
            daily_upkeep: {
              western: {
                cost: {
                  fuel: 40,
                  cash: 80,
                },
              },
            },
          },
          "4": {
            requirements: ["air_base level 2", "recruiting_office level 3", "strike_fighter level 3"],
            research: {
              western: {
                unlock_day: 1,
                time: { hours: 4 },
                cost: {
                  supplies: 10,
                  components: 20,
                  rares: 5,
                  electronics: 30,
                  cash: 100,
                },
              },
            },
            mobilisation: {
              western: {
                time: { hours: 14 },
                cost: {
                  supplies: 140,
                  components: 70,
                  fuel: 34,
                  electronics: 20,
                  cash: 280,
                  manpower: 7,
                },
              },
            },
            daily_upkeep: {
              western: {
                cost: {
                  fuel: 42,
                  cash: 84,
                },
              },
            },
          },
          "5": {
            requirements: ["air_base level 3", "recruiting_office level 3", "strike_fighter level 4"],
            research: {
              western: {
                unlock_day: 1,
                time: { hours: 5 },
                cost: {
                  supplies: 10,
                  components: 20,
                  rares: 5,
                  electronics: 30,
                  cash: 100,
                },
              },
            },
            mobilisation: {
              western: {
                time: { hours: 15 },
                cost: {
                  supplies: 150,
                  components: 75,
                  fuel: 35,
                  electronics: 22,
                  cash: 300,
                  manpower: 8,
                },
              },
            },
            daily_upkeep: {
              western: {
                cost: {
                  fuel: 44,
                  cash: 88,
                },
              },
            },
          },
        },
      },
    },
  } as unknown as UnitCatalog;
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
              electronics: 25,
              cash: 200,
            },
          },
          "2": {
            build_time: { hours: 2 },
            mobilisation_speed_bonus_pct: 0.25,
            cost: {
              supplies: 200,
              components: 75,
              electronics: 50,
              cash: 300,
            },
          },
          "3": {
            build_time: { hours: 3 },
            mobilisation_speed_bonus_pct: 0.4,
            cost: {
              supplies: 300,
              components: 100,
              electronics: 75,
              cash: 400,
            },
          },
          "4": undefined,
          "5": undefined,
        },
      },
    },
  };
}

test("calculateMobilizationCost multiplies unit mobilisation cost by count", () => {
  const catalog = buildTestUnitCatalog();

  assert.deepEqual(calculateMobilizationCost("strike_fighter", 2, 3, catalog, "western"), {
    supplies: 360,
    components: 180,
    fuel: 90,
    electronics: 45,
    cash: 720,
    manpower: 18,
  });
});

test("calculateUpkeepCost scales daily upkeep by hours and count", () => {
  const catalog = buildTestUnitCatalog();

  assert.deepEqual(calculateUpkeepCost("strike_fighter", 1, 2, 36, catalog, "western"), {
    fuel: 72,
    cash: 144,
  });
});

test("calculateBuildingCost sums intermediate recruiting office levels", () => {
  const buildings = buildTestBuildings();

  assert.deepEqual(calculateBuildingCost("recruiting_office", 0, 2, buildings), {
    supplies: 300,
    components: 125,
    electronics: 75,
    cash: 500,
  });
});

test("calculateMobilizationDuration applies morale slowdown and recruiting office bonus", () => {
  const catalog = buildTestUnitCatalog();
  const buildings = buildTestBuildings();

  assert.equal(calculateMobilizationDuration("strike_fighter", 2, 3, 2, 2, catalog, buildings, "western", 25), 26);
});

test("calculateCompletionHour uses per-city allocation and research completion times", () => {
  const catalog = buildTestUnitCatalog();
  const buildings = buildTestBuildings();

  const completionHour = calculateCompletionHour(
    "strike_fighter",
    {
      cities: [
        { cityId: "alpha", roLevel: 2, unitsAllocated: 3 },
        { cityId: "bravo", roLevel: 1, unitsAllocated: 1 },
      ],
      buildingCost: 0,
    },
    { 1: 4 },
    [{ level: 1, startHour: 0, endHour: 5 }],
    catalog,
    buildings,
    "western"
  );

  assert.equal(completionHour, 29);
});

test("calculateTotalCost returns scalarized building, mobilisation, and upkeep totals", () => {
  const catalog = buildTestUnitCatalog();
  const buildings = buildTestBuildings();
  const config = {
    cities: [
      { cityId: "alpha", roLevel: 2, unitsAllocated: 3 },
      { cityId: "bravo", roLevel: 1, unitsAllocated: 1 },
    ],
    buildingCost: resourceCostToScalar(calculateBuildingCost("recruiting_office", 0, 2, buildings)) * 2,
    buildingCostByCity: { alpha: 812.5, bravo: 812.5 },
  };

  const result = calculateTotalCost(
    "strike_fighter",
    config,
    { 1: 4 },
    [{ level: 1, startHour: 0, endHour: 5 }],
    30,
    catalog,
    buildings,
    "western"
  );

  // Updated expected values to reflect new resource weights:
  // Electronics: 3.0, Supplies: 2.0, Rares: 1.5 (vs old: 1.5, 1.0, 2.0)
  // Upkeep uses calculateTriangularUpkeepForConfig: each unit pays only from when
  // it individually finishes mobilising (staggered per city) to the deadline, so
  // it's not a flat count × rate — see cost-calculator.ts for the formula.
  assert.deepEqual(result, {
    building: 2450,      // Building cost increased due to higher electronics weight
    mobilization: 1660,  // Mobilization cost increased (electronics + supplies weighted higher)
    upkeep: 77.23636363636363,
    total: 4187.236363636363,
    feasible: true,
    details: {
      mobilizationByLevel: { 1: 1660 },
      upkeepByLevel: { 1: 77.23636363636363 },
      buildingByCity: { alpha: 812.5, bravo: 812.5 },
    },
  });
});

test("calculateTotalCost marks configs infeasible when mobilisation misses the deadline", () => {
  const catalog = buildTestUnitCatalog();
  const buildings = buildTestBuildings();

  const result = calculateTotalCost(
    "strike_fighter",
    {
      cities: [{ cityId: "alpha", roLevel: 1, unitsAllocated: 4 }],
      buildingCost: 100,
    },
    { 1: 4 },
    [{ level: 1, startHour: 0, endHour: 5 }],
    20,
    catalog,
    buildings,
    "western"
  );

  assert.equal(result.feasible, false);
  assert.equal(result.total, Number.POSITIVE_INFINITY);
});
