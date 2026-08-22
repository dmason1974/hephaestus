import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { loadEnumerations } from "../scenarios/io/load-enums.js";
import { buildUnitCatalogSchema, parseUnitCatalog } from "./unit-schema.js";

test("unit catalog schema accepts mobilisation unit_limit", () => {
  const enums = loadEnumerations(path.resolve("data/enums.yml"));
  const result = buildUnitCatalogSchema(enums).safeParse({
    schema_version: 1,
    domain: "units",
    resources: ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"],
    units: {
      elite_frigate: {
        name: "Elite Frigate",
        category: "Naval",
        doctrine: ["western"],
        levels: {
          1: {
            requirements: ["frigate level 1"],
            research: {
              western: {
                unlock_day: 3,
                time: { hours: 21 },
                cost: { supplies: 1, components: 1, fuel: 1, rares: 1, electronics: 1, cash: 1 },
              },
            },
            mobilisation: {
              western: {
                time: { hours: 24 },
                cost: { supplies: 1, components: 1, fuel: 1, rares: 1, electronics: 1, cash: 1, manpower: 1 },
                unit_limit: 5,
              },
            },
            daily_upkeep: {
              western: {
                cost: {},
              },
            },
          },
        },
      },
    },
  });

  assert.equal(result.success, true);
});

test("unit catalog schema rejects malformed resource cost values", () => {
  const enums = loadEnumerations(path.resolve("data/enums.yml"));
  const result = buildUnitCatalogSchema(enums).safeParse({
    schema_version: 1,
    domain: "units",
    resources: ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"],
    units: {
      frigate: {
        name: "Frigate",
        category: "Naval",
        doctrine: ["western"],
        levels: {
          1: {
            requirements: ["naval_base level 2"],
            research: {
              western: {
                unlock_day: 2,
                time: { hours: 1 },
                cost: { supplies: 1, components: 1, fuel: 1, rares: 1, electronics: 1, cash: 1 },
              },
            },
            mobilisation: {
              western: {
                time: { hours: 1 },
                cost: { supplies: 1, components: 1, fuel: 1, rares: 1, electronics: 1, cash: 1, manpower: 1 },
              },
            },
            daily_upkeep: {
              western: {
                cost: { manpower: { invalid: true } },
              },
            },
          },
        },
      },
    },
  });

  assert.equal(result.success, false);
});
