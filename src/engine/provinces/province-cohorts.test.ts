import test from "node:test";
import assert from "node:assert/strict";

import { buildProvinceCohortsFromCountry } from "./province-cohorts.js";

test("buildProvinceCohortsFromCountry derives resource and non-resource cohorts", () => {
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
      supplies: 2,
      components: 1,
      fuel: 0,
      rares: 0,
      electronics: 0,
    },
  } as const;

  const cohorts = buildProvinceCohortsFromCountry(country);

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
