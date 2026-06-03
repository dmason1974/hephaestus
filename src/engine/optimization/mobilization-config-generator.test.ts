import assert from "node:assert/strict";
import test from "node:test";

import type { BuildingsFile } from "../../schemas/building-schema.js";
import type { UnitCatalog } from "../../schemas/unit-schema.js";
import { generateMobilizationConfigs, filterFeasibleConfigs } from "./mobilization-config-generator.js";

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
            unlock_day: 1,
            research: { western: { time: { hours: 1 }, cost: {} } },
            mobilisation: { western: { time: { hours: 10 }, cost: { supplies: 100, cash: 100 } } },
            daily_upkeep: { western: { cost: { cash: 24 } } },
          },
          "2": {
            requirements: ["air_base level 1", "recruiting_office level 2", "strike_fighter level 1"],
            unlock_day: 1,
            research: { western: { time: { hours: 2 }, cost: {} } },
            mobilisation: { western: { time: { hours: 12 }, cost: { supplies: 120, cash: 120 } } },
            daily_upkeep: { western: { cost: { cash: 36 } } },
          },
          "3": {
            requirements: ["air_base level 2", "recruiting_office level 2", "strike_fighter level 2"],
            unlock_day: 1,
            research: { western: { time: { hours: 3 }, cost: {} } },
            mobilisation: { western: { time: { hours: 13 }, cost: { supplies: 130, cash: 130 } } },
            daily_upkeep: { western: { cost: { cash: 40 } } },
          },
          "4": {
            requirements: ["air_base level 2", "recruiting_office level 3", "strike_fighter level 3"],
            unlock_day: 1,
            research: { western: { time: { hours: 4 }, cost: {} } },
            mobilisation: { western: { time: { hours: 14 }, cost: { supplies: 140, cash: 140 } } },
            daily_upkeep: { western: { cost: { cash: 42 } } },
          },
          "5": {
            requirements: ["air_base level 3", "recruiting_office level 3", "strike_fighter level 4"],
            unlock_day: 1,
            research: { western: { time: { hours: 5 }, cost: {} } },
            mobilisation: { western: { time: { hours: 15 }, cost: { supplies: 150, cash: 150 } } },
            daily_upkeep: { western: { cost: { cash: 44 } } },
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
              fuel: 0,
              rares: 0,
              electronics: 25,
              cash: 200,
              manpower: 0,
            },
          },
          "2": {
            build_time: { hours: 2 },
            mobilisation_speed_bonus_pct: 0.25,
            cost: {
              supplies: 200,
              components: 75,
              fuel: 0,
              rares: 0,
              electronics: 50,
              cash: 300,
              manpower: 0,
            },
          },
          "3": {
            build_time: { hours: 3 },
            mobilisation_speed_bonus_pct: 0.4,
            cost: {
              supplies: 300,
              components: 100,
              fuel: 0,
              rares: 0,
              electronics: 75,
              cash: 400,
              manpower: 0,
            },
          },
          "4": undefined,
          "5": undefined,
        },
      },
    },
  };
}

test("generateMobilizationConfigs enumerates city-count and RO-level combinations in cost order", () => {
  const configs = generateMobilizationConfigs(["alpha", "bravo", "charlie"], 2, 2, 5, {
    buildings: buildTestBuildings(),
  });

  assert.equal(configs.length, 4);
  assert.deepEqual(
    configs.map(config => ({
      cityCount: config.cities.length,
      roLevel: config.cities[0]?.roLevel,
      units: config.cities.map(city => city.unitsAllocated),
      buildingCost: config.buildingCost,
    })),
    // Updated expected values to reflect new resource weights (Electronics: 3.0, Supplies: 2.0, Rares: 1.5)
    [
      { cityCount: 1, roLevel: 1, units: [5], buildingCost: 435 },      // Was 297.5
      { cityCount: 2, roLevel: 1, units: [3, 2], buildingCost: 870 },   // Was 595
      { cityCount: 1, roLevel: 2, units: [5], buildingCost: 1225 },     // Was 812.5
      { cityCount: 2, roLevel: 2, units: [3, 2], buildingCost: 2450 },  // Was 1625
    ]
  );
});

test("generateMobilizationConfigs handles a single city edge case", () => {
  const configs = generateMobilizationConfigs(["alpha"], 3, 3, 4);

  assert.deepEqual(
    configs.map(config => ({
      cityCount: config.cities.length,
      roLevel: config.cities[0]?.roLevel,
      units: config.cities.map(city => city.unitsAllocated),
    })),
    [
      { cityCount: 1, roLevel: 1, units: [4] },
      { cityCount: 1, roLevel: 2, units: [4] },
      { cityCount: 1, roLevel: 3, units: [4] },
    ]
  );
});

test("filterFeasibleConfigs removes configs that miss the deadline", () => {
  const buildings = buildTestBuildings();
  const catalog = buildTestUnitCatalog();
  const configs = generateMobilizationConfigs(["alpha", "bravo"], 2, 2, 4, { buildings });

  const feasible = filterFeasibleConfigs(configs, {
    unitId: "strike_fighter",
    batchAllocation: { 1: 4 },
    researchSchedule: [{ level: 1, startHour: 0, endHour: 5 }],
    deadlineHour: 25,
    unitCatalog: catalog,
    buildings,
    doctrine: "western",
  });

  assert.deepEqual(
    feasible.map(config => ({
      cityCount: config.cities.length,
      roLevel: config.cities[0]?.roLevel,
    })),
    [
      { cityCount: 2, roLevel: 1 },
      { cityCount: 2, roLevel: 2 },
    ]
  );
});
