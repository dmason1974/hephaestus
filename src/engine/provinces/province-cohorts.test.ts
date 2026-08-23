import test from "node:test";
import assert from "node:assert/strict";

import { buildProvinceCohortsFromCountry } from "./province-cohorts.js";

const country = {
  version: 1,
  country: {
    id: "testland",
    name: "Testland",
    doctrine: "western",
  },
  cities: [],
  provinces: {
    total: 10,
  },
} as const;

test("buildProvinceCohortsFromCountry derives resource and non-resource cohorts from game-specific tiles", () => {
  const cohorts = buildProvinceCohortsFromCountry(country, { supplies: 2, components: 1 });

  assert.deepEqual(
    cohorts.map(cohort => ({
      id: cohort.cohortId,
      resource: cohort.resource,
      resourceProvinceCount: cohort.resourceProvinceCount,
      totalProvinceCount: cohort.totalProvinceCount,
    })),
    [
      {
        id: "testland:supplies_provinces",
        resource: "supplies",
        resourceProvinceCount: 2,
        totalProvinceCount: 2,
      },
      {
        id: "testland:components_provinces",
        resource: "components",
        resourceProvinceCount: 1,
        totalProvinceCount: 1,
      },
      {
        id: "testland:non_resource_provinces",
        resource: null,
        resourceProvinceCount: 0,
        totalProvinceCount: 7,
      },
    ]
  );
});

test("buildProvinceCohortsFromCountry treats every province as non-resource when tiles are omitted", () => {
  // Tile distribution is a per-game observation (coalition plan), not a country
  // property. Without it, nothing is known to produce a resource — this is the
  // "default" ranking, before a playthrough's tiles have been observed.
  const cohorts = buildProvinceCohortsFromCountry(country);

  assert.deepEqual(
    cohorts.map(cohort => ({ id: cohort.cohortId, resource: cohort.resource, totalProvinceCount: cohort.totalProvinceCount })),
    [{ id: "testland:non_resource_provinces", resource: null, totalProvinceCount: 10 }]
  );
});

test("buildProvinceCohortsFromCountry rejects tiles that sum past the province total", () => {
  assert.throws(
    () => buildProvinceCohortsFromCountry(country, { supplies: 8, components: 5 }),
    /province_tiles sum to 13 but the country only has 10 provinces/
  );
});
