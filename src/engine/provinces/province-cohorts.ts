import type { Resource } from "../../core/constants.js";
import type { Country } from "../../schemas/country-schema.js";
import type { ProvinceState } from "../simulation/province-build-order-sim.js";

export type ProvinceCohort = ProvinceState & {
  cohortId: string;
  resource: Exclude<Resource, "cash" | "manpower"> | null;
};

const RESOURCE_PROVINCE_KEYS = [
  "supplies",
  "components",
  "fuel",
  "rares",
  "electronics",
] as const;

export function buildProvinceCohortsFromCountry(country: Country): ProvinceCohort[] {
  const provinces = country.provinces ?? {
    total: 0,
    supplies: 0,
    components: 0,
    fuel: 0,
    rares: 0,
    electronics: 0,
  };
  const resourceProvinceTotal = RESOURCE_PROVINCE_KEYS.reduce(
    (sum, key) => sum + provinces[key],
    0
  );
  const nonResourceProvinceCount = Math.max(0, provinces.total - resourceProvinceTotal);

  const cohorts: ProvinceCohort[] = RESOURCE_PROVINCE_KEYS
    .filter(resource => provinces[resource] > 0)
    .map(resource => ({
      cohortId: `${country.country.id}:${resource}_provinces`,
      provinceId: `${country.country.id}:${resource}_provinces`,
      countryId: country.country.id,
      resource,
      resourceProvinceCount: provinces[resource],
      totalProvinceCount: provinces[resource],
      buildings: {
        combat_outpost: 0,
        local_industry: 0,
      },
    }));

  if (nonResourceProvinceCount > 0) {
    cohorts.push({
      cohortId: `${country.country.id}:non_resource_provinces`,
      provinceId: `${country.country.id}:non_resource_provinces`,
      countryId: country.country.id,
      resource: null,
      resourceProvinceCount: 0,
      totalProvinceCount: nonResourceProvinceCount,
      buildings: {
        combat_outpost: 0,
        local_industry: 0,
      },
    });
  }

  return cohorts;
}
