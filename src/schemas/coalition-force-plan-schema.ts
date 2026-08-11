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
  })
  .strict();

const countryPlanSchema = z
  .object({
    status: z.enum(["homeland", "occupied"]),
    // Day this country is captured (only meaningful when status: occupied). Defaults
    // to day 4 at the call site when omitted.
    capture_day: z.number().int().min(1).optional(),
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
