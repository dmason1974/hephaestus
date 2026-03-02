import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildingsFileSchema,
  validateBuildingsFile,
} from "./buildingSchema.js";

test("buildings.yml validates against the strict buildings file schema", () => {
  const filePath = path.resolve("data/buildings.yml");
  const parsed = validateBuildingsFile(filePath);

  assert.equal(parsed.domain, "buildings");
  assert.ok(Object.keys(parsed.buildings).length > 0);
  const armyBase = parsed.buildings.army_base;
  assert.ok(armyBase);
  const level1 = armyBase.levels["1"];
  assert.ok(level1);
  assert.equal(level1.cost.cash, 2000);
});

test("building levels reject keys outside 1..5", () => {
  const result = buildingsFileSchema.safeParse({
    schema_version: 1,
    domain: "buildings",
    resources: ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"],
    buildings: {
      test_building: {
        name: "Test Building",
        category: "Buildings",
        levels: {
          6: {
            build_time: { hours: 1 },
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
        },
      },
    },
  });

  assert.equal(result.success, false);
});
