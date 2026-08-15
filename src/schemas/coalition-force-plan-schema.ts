import { z } from "zod";

const resourceSchema = z.enum([
  "supplies",
  "components",
  "fuel",
  "rares",
  "electronics",
  "cash",
  "manpower",
]);

const demandSchema = z
  .object({
    unitId: z.string().min(1),
    count: z.number().int().min(1),
    mobilisation_source: z.enum(["province"]).optional(),
    // Pins this demand to exactly these city IDs (bare, e.g. "new_delhi"), splitting
    // count evenly across them, instead of the default cost-driven city search in
    // foldInDemands. Optional — city assignment stays fully automatic when absent.
    preferred_cities: z.array(z.string().min(1)).min(1).optional(),
    // Overrides the recruiting_office level a pinned demand's city search floors
    // at (estimateRoLevelForFixedCityCount otherwise picks the cheapest RO level
    // that fits this demand's own count, unaware another demand may later share
    // the same city and need more RO throughput than this demand alone would
    // ever choose). Only meaningful alongside preferred_cities.
    min_ro: z.number().int().min(1).max(5).optional(),
  })
  .strict();

// cohort resource key (or "non_resource") -> homeland country id -> province count
// credited to it. Only meaningful when status: occupied. Sum of values for a given
// cohort must not exceed that cohort's real province count (validated at load time,
// not here — zod can't express a cross-field constraint against country YAML data).
// Keyed by plain z.string(), not z.enum(...) — z.record() with an enum/literal key
// schema requires every enum member present (a full record), not a sparse/partial
// map, which is not what a cohort-keyed credit map needs (confirmed: this broke
// parsing of every existing plan file until switched to z.string() here).
const PROVINCE_CREDIT_KEYS = ["supplies", "components", "fuel", "rares", "electronics", "non_resource"] as const;
const provinceCreditsSchema = z.record(
  z.string().min(1).refine(k => (PROVINCE_CREDIT_KEYS as readonly string[]).includes(k), {
    message: `must be one of: ${PROVINCE_CREDIT_KEYS.join(", ")}`,
  }),
  z.record(z.string().min(1), z.number().int().min(1)),
);

const countryPlanSchema = z
  .object({
    status: z.enum(["homeland", "occupied"]),
    // Day this country is captured (only meaningful when status: occupied). Defaults
    // to day 4 at the call site when omitted.
    capture_day: z.number().int().min(1).optional(),
    // Only meaningful when status: occupied. Bare city id -> homeland country id this
    // city's production is transferred to (manpower is PER_COUNTRY_RESOURCES — never
    // pooled — so without this an annexed city's manpower is stranded on this
    // country's own dead ledger). A credited city is excluded entirely from this
    // country's own report.
    city_credits: z.record(z.string().min(1), z.string().min(1)).optional(),
    // Only meaningful when status: occupied. See provinceCreditsSchema above.
    province_credits: provinceCreditsSchema.optional(),
    demands: z.array(demandSchema),
  })
  .strict();

export const coalitionForcePlanSchema = z
  .object({
    schema_version: z.number().int(),
    domain: z.literal("coalition_force_plan"),
    name: z.string().min(1),
    scenario: z.string().min(1),
    truce_days: z.number().int().min(1),
    resource_priority: z.array(resourceSchema).optional(),
    search: z
      .object({
        top: z.number().int().min(1).optional(),
        max_arms_industry_level: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),
    countries: z.record(z.string().min(1), countryPlanSchema),
  })
  .strict();

export type CoalitionForcePlan = z.infer<typeof coalitionForcePlanSchema>;
export type CountryPlan = z.infer<typeof countryPlanSchema>;
export type Demand = z.infer<typeof demandSchema>;

export function parseCoalitionForcePlan(input: unknown, source = "coalition force plan"): CoalitionForcePlan {
  const result = coalitionForcePlanSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid coalition force plan (${source}):\n${result.error.toString()}`);
  }
  return result.data;
}
