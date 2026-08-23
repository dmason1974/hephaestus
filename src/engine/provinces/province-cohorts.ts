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

/**
 * How many of a country's provinces carry each resource tile, for one specific
 * game. Randomised per playthrough, so it comes from the coalition plan
 * (countries.<id>.province_tiles), never from the country YAML — which carries
 * only `provinces.total`.
 */
export type ProvinceTiles = Partial<Record<(typeof RESOURCE_PROVINCE_KEYS)[number], number>>;

/** Warn at most once per country so the message is visible without spamming every call site. */
const warnedCountries = new Set<string>();

/**
 * Splits a country's provinces into per-resource cohorts plus a non-resource
 * remainder.
 *
 * `tiles` is game-specific and optional. When omitted, tile assignment is
 * unknown and EVERY province is treated as non-resource-producing — this is the
 * "default" ranking, before a playthrough's tiles have been observed. Supplying
 * tiles yields the "bespoke" ranking for that game.
 */
export function buildProvinceCohortsFromCountry(
  country: Country,
  tiles?: ProvinceTiles
): ProvinceCohort[] {
  const total = country.provinces?.total ?? 0;
  const resolved: Record<(typeof RESOURCE_PROVINCE_KEYS)[number], number> = {
    supplies: tiles?.supplies ?? 0,
    components: tiles?.components ?? 0,
    fuel: tiles?.fuel ?? 0,
    rares: tiles?.rares ?? 0,
    electronics: tiles?.electronics ?? 0,
  };

  const resourceProvinceTotal = RESOURCE_PROVINCE_KEYS.reduce(
    (sum, key) => sum + resolved[key],
    0
  );

  if (resourceProvinceTotal > total) {
    throw new Error(
      `${country.country.id}: province_tiles sum to ${resourceProvinceTotal} but the country ` +
        `only has ${total} provinces. Fix countries.${country.country.id}.province_tiles in the plan.`
    );
  }

  if (total > 0 && tiles === undefined && !warnedCountries.has(country.country.id)) {
    warnedCountries.add(country.country.id);
    console.warn(
      `[provinces] ${country.country.id}: no province_tiles supplied — treating all ${total} ` +
        `provinces as non-resource-producing. Resource province yield will be understated. ` +
        `Set countries.${country.country.id}.province_tiles in the coalition plan.`
    );
  }

  const nonResourceProvinceCount = Math.max(0, total - resourceProvinceTotal);

  const cohorts: ProvinceCohort[] = RESOURCE_PROVINCE_KEYS
    .filter(resource => resolved[resource] > 0)
    .map(resource => ({
      cohortId: `${country.country.id}:${resource}_provinces`,
      provinceId: `${country.country.id}:${resource}_provinces`,
      countryId: country.country.id,
      resource,
      resourceProvinceCount: resolved[resource],
      totalProvinceCount: resolved[resource],
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
