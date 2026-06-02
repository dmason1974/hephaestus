import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import YAML from "yaml";

import { loadEnumerations } from "../scenarios/io/load-enums.js";
import { buildUnitCatalogSchema, parseUnitCatalog } from "./unit-schema.js";

test("naval_units.yml validates against the unit catalog schema", () => {
  const enums = loadEnumerations(path.resolve("data/enums.yml"));
  const filePath = path.resolve("data/scenarios/standard/units/naval_units.yml");
  const raw = YAML.parse(fs.readFileSync(filePath, "utf8"));
  const parsed = parseUnitCatalog(raw, enums, filePath);

  assert.equal(parsed.domain, "units");
  assert.ok(parsed.units.frigate);
  assert.equal(parsed.units.naval_veteran.doctrine, "western");
});

test("seasonal_units.yml validates against the unit catalog schema", () => {
  const enums = loadEnumerations(path.resolve("data/enums.yml"));
  const filePath = path.resolve("data/scenarios/standard/units/seasonal_units.yml");
  const raw = YAML.parse(fs.readFileSync(filePath, "utf8"));
  const parsed = parseUnitCatalog(raw, enums, filePath);

  assert.equal(parsed.domain, "units");
  assert.ok(parsed.units.elite_frigate);
  assert.equal(parsed.units.elite_drone_mothership.doctrine, "western");
  assert.equal(parsed.units.elite_frigate.levels["1"]?.mobilisation.unit_limit, 5);
});

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
        doctrine: "western",
        levels: {
          1: {
            requirements: ["frigate level 1"],
            research: {
              unlock_day: 3,
              time: { hours: 21 },
              cost: {
                supplies: 1,
                components: 1,
                fuel: 1,
                rares: 1,
                electronics: 1,
                cash: 1,
                manpower: 0,
              },
            },
            mobilisation: {
              time: { hours: 24 },
              cost: {
                supplies: 1,
                components: 1,
                fuel: 1,
                rares: 1,
                electronics: 1,
                cash: 1,
                manpower: 1,
              },
              unit_limit: 5,
            },
            daily_upkeep: {
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
        doctrine: "western",
        levels: {
          1: {
            requirements: ["naval_base level 2"],
            research: {
              unlock_day: 2,
              time: { hours: 1 },
              cost: {
                supplies: 1,
                components: 1,
                fuel: 1,
                rares: 1,
                electronics: 1,
                cash: 1,
                manpower: 0,
              },
            },
            mobilisation: {
              time: { hours: 1 },
              cost: {
                supplies: 1,
                components: 1,
                fuel: 1,
                rares: 1,
                electronics: 1,
                cash: 1,
                manpower: 1,
              },
            },
            daily_upkeep: {
              cost: {
                supplies: 0,
                components: 0,
                fuel: 0,
                rares: 0,
                electronics: 0,
                cash: 0,
                manpower: { invalid: true },
              },
            },
          },
        },
      },
    },
  });

  assert.equal(result.success, false);
});
