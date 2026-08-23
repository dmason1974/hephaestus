import test from "node:test";
import assert from "node:assert/strict";

import type { BuildingsFile } from "../../schemas/building-schema.js";
import type { Country } from "../../schemas/country-schema.js";
import type { ProvinceCohort } from "../provinces/province-cohorts.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { buildCostForSequence, runProvinceEcoBeam, scoreCohort } from "./province-eco-beam.js";

// Minimal literal fixture for the pure-function tests (buildCostForSequence,
// scoreCohort) — these don't touch scheduleBuildSegments, which (unlike the
// cost/score functions under test) needs the full real building catalog to
// resolve timings for every BuildingId, not just the two used by provinces.
const buildings: BuildingsFile = {
  schema_version: 1,
  domain: "buildings",
  resources: ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"],
  buildings: {
    combat_outpost: {
      name: "Combat Outpost",
      category: "Buildings",
      levels: {
        "1": {
          build_time: { hours: 1 },
          cost: { supplies: 500, components: 750, cash: 2000 },
          morale_bonus_pct: 0.05,
        },
      },
    },
    local_industry: {
      name: "Local Industry",
      category: "Buildings",
      levels: {
        "1": {
          build_time: { hours: 1 },
          cost: { supplies: 300 },
          production_bonus_pct: 0.1,
        },
      },
    },
  },
};

test("buildCostForSequence charges the raw per-instance cost for a 1-province cohort", () => {
  const cost = buildCostForSequence(buildings, [{ buildingId: "combat_outpost", targetLevel: 1 }], 1);
  assert.deepEqual(cost, { supplies: 500, components: 750, cash: 2000 });
});

test("buildCostForSequence scales cost by province count — the sequence is built in every province in the cohort", () => {
  const cost = buildCostForSequence(buildings, [{ buildingId: "combat_outpost", targetLevel: 1 }], 32);
  assert.deepEqual(cost, { supplies: 500 * 32, components: 750 * 32, cash: 2000 * 32 });
});

const resourceCohort: ProvinceCohort = {
  cohortId: "testland:supplies_provinces",
  provinceId: "testland:supplies_provinces",
  countryId: "testland",
  resource: "supplies",
  resourceProvinceCount: 3,
  totalProvinceCount: 3,
  buildings: { combat_outpost: 0, local_industry: 0, mercenary_outpost: 0 },
};

const nonResourceCohort: ProvinceCohort = {
  cohortId: "testland:non_resource_provinces",
  provinceId: "testland:non_resource_provinces",
  countryId: "testland",
  resource: null,
  resourceProvinceCount: 0,
  totalProvinceCount: 7,
  buildings: { combat_outpost: 0, local_industry: 0, mercenary_outpost: 0 },
};

const total = { supplies: 100, components: 0, fuel: 0, rares: 0, electronics: 0, cash: 40, manpower: 9 };

test("scoreCohort sums the tile resource plus cash plus manpower for a resource cohort", () => {
  assert.equal(scoreCohort(resourceCohort, total), 100 + 40 + 9);
});

test("scoreCohort sums cash plus manpower (no resource component) for a non-resource cohort", () => {
  assert.equal(scoreCohort(nonResourceCohort, total), 40 + 9);
});

const scenario = { start: { day: 1, hour: 15 }, speed: "4x" as const };

test("runProvinceEcoBeam still picks combat_outpost L1 alone for a non-resource cohort, cost scaled by province count", () => {
  const realBuildings = loadBuildingsFile();
  const country: Country = {
    version: 1,
    country: { id: "testland", name: "Testland", doctrine: "western" },
    cities: [],
    provinces: { total: 7 },
  };

  const results = runProvinceEcoBeam(country, scenario, realBuildings, { hoursToSimulate: 240 });

  const nonResource = results.find(r => r.cohortId === "testland:non_resource_provinces");
  assert.ok(nonResource);
  assert.deepEqual(
    nonResource.bestActions.map(a => ({ buildingId: a.buildingId, targetLevel: a.targetLevel })),
    [{ buildingId: "combat_outpost", targetLevel: 1 }]
  );

  const combatOutpostL1Cost = realBuildings.buildings.combat_outpost?.levels["1"]?.cost ?? {};
  const expectedCost = Object.fromEntries(
    Object.entries(combatOutpostL1Cost).map(([resource, amount]) => [resource, (amount ?? 0) * 7])
  );
  assert.deepEqual(nonResource.totalEcoBuildCost, expectedCost);
});
