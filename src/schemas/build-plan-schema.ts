import { z } from "zod";

const positiveIntSchema = z.number().int().min(1);
const nonNegativeIntSchema = z.number().int().min(0);

const buildStepSchema = z.object({
  buildingId: z.string().min(1),
  targetLevel: positiveIntSchema,
  start_hour: nonNegativeIntSchema,
}).strict();

const cityBuildPlanSchema = z.object({
  cityId: z.string().min(1),
  cityName: z.string().min(1),
  resource: z.string().min(1),
  build_order: z.array(buildStepSchema),
}).strict();

export const buildPlanFileSchema = z.object({
  schema_version: z.number().int().min(1),
  domain: z.literal("build_plan"),
  name: z.string().min(1),
  scenario: z.string().min(1),
  country: z.string().min(1),
  source_html: z.string().min(1).optional(),
  city_plans: z.array(cityBuildPlanSchema).min(1),
}).strict();

export type BuildPlanFile = z.infer<typeof buildPlanFileSchema>;

export function parseBuildPlanFile(input: unknown, source = "build plan input"): BuildPlanFile {
  const result = buildPlanFileSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid build plan (${source}):\n${result.error.toString()}`);
  }
  return result.data;
}
