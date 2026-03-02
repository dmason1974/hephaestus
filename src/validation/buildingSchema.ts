import fs from "node:fs";
import YAML from "yaml";
import { z } from "zod";

export const resourceSchema = z.enum([
  "supplies",
  "components",
  "fuel",
  "rares",
  "electronics",
  "cash",
  "manpower",
]);

const nonNegativeNumberSchema = z.number().min(0);
const nonNegativeIntSchema = z.number().int().min(0);

const completeResourceRecordSchema = z
  .object({
    supplies: nonNegativeNumberSchema,
    components: nonNegativeNumberSchema,
    fuel: nonNegativeNumberSchema,
    rares: nonNegativeNumberSchema,
    electronics: nonNegativeNumberSchema,
    cash: nonNegativeNumberSchema,
    manpower: nonNegativeNumberSchema,
  })
  .strict();

const partialResourceRecordSchema = z
  .object({
    supplies: nonNegativeNumberSchema.optional(),
    components: nonNegativeNumberSchema.optional(),
    fuel: nonNegativeNumberSchema.optional(),
    rares: nonNegativeNumberSchema.optional(),
    electronics: nonNegativeNumberSchema.optional(),
    cash: nonNegativeNumberSchema.optional(),
    manpower: nonNegativeNumberSchema.optional(),
  })
  .strict();

const percentSchema = z.number().min(0).max(1);

const buildTimeSchema = z
  .object({
    days: nonNegativeIntSchema.optional(),
    hours: nonNegativeIntSchema.optional(),
    minutes: nonNegativeIntSchema.optional(),
    seconds: nonNegativeIntSchema.optional(),
  })
  .strict()
  .refine(
    value => Object.values(value).some(part => part !== undefined),
    "build_time must include at least one of days, hours, minutes, or seconds"
  );

export const buildingLevelSchema = z
  .object({
    build_time: buildTimeSchema,
    cost: completeResourceRecordSchema,
    daily_upkeep: partialResourceRecordSchema.optional(),
    flat_bonus: partialResourceRecordSchema.optional(),
    hit_points: nonNegativeNumberSchema.optional(),
    production_bonus_pct: percentSchema.optional(),
    garrison_damage_reduction_pct: percentSchema.optional(),
    morale_bonus_pct: percentSchema.optional(),
    population_protection_level: nonNegativeIntSchema.optional(),
    shields: z.array(z.string()).optional(),
  })
  .strict();

const levelsSchema = z
  .object({
    "1": buildingLevelSchema.optional(),
    "2": buildingLevelSchema.optional(),
    "3": buildingLevelSchema.optional(),
    "4": buildingLevelSchema.optional(),
    "5": buildingLevelSchema.optional(),
  })
  .strict()
  .refine(
    value => Object.values(value).some(level => level !== undefined),
    "levels must include at least one key between 1 and 5"
  );

export const buildingSchema = z
  .object({
    name: z.string().min(1),
    category: z.literal("Buildings"),
    is_secret: z.boolean().optional(),
    levels: levelsSchema,
  })
  .strict();

export const buildingsFileSchema = z
  .object({
    schema_version: z.number(),
    domain: z.literal("buildings"),
    notes: z.array(z.string()).optional(),
    resources: z.array(resourceSchema),
    buildings: z.record(z.string().min(1), buildingSchema),
  })
  .strict();

export type BuildingLevel = z.infer<typeof buildingLevelSchema>;
export type Building = z.infer<typeof buildingSchema>;
export type BuildingsFile = z.infer<typeof buildingsFileSchema>;

export function validateBuildingsFile(filePath: string): BuildingsFile {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = YAML.parse(raw);
  const result = buildingsFileSchema.safeParse(parsed);

  if (!result.success) {
    throw new Error(
      `Invalid buildings YAML (${filePath}):\n${result.error.toString()}`
    );
  }

  return result.data;
}
