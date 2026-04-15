import { z } from "zod";

const nonNegativeIntSchema = z.number().int().min(0);
const positiveIntSchema = z.number().int().min(1);

const forceDemandSchema = z.object({
  unitId: z.string().min(1),
  count: positiveIntSchema,
  researchTargetLevel: positiveIntSchema.optional(),
  minMobilizeLevel: positiveIntSchema.optional(),
  queueGroup: z.string().min(1).optional(),
}).strict();

export const forcePlanFileSchema = z.object({
  schema_version: z.number().int().min(1),
  domain: z.literal("force_plan"),
  name: z.string().min(1),
  scenario: z.string().min(1),
  country: z.string().min(1),
  truce_days: positiveIntSchema,
  search: z.object({
    top: positiveIntSchema.optional(),
    max_extra_cities: nonNegativeIntSchema.optional(),
    max_recruiting_office_level: positiveIntSchema.optional(),
  }).strict().optional(),
  demands: z.array(forceDemandSchema).min(1),
}).strict();

export type ForcePlanFile = z.infer<typeof forcePlanFileSchema>;

export function parseForcePlanFile(input: unknown, source = "force plan input"): ForcePlanFile {
  const result = forcePlanFileSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid force plan (${source}):\n${result.error.toString()}`);
  }
  return result.data;
}
