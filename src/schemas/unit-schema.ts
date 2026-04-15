import { z } from "zod";

import type { Enumerations } from "./enums-schema.js";

const SnakeCaseId = z
  .string()
  .min(1)
  .regex(/^[a-z0-9']+(?:_[a-z0-9']+)*$/, "Expected lowercase id with underscores/apostrophes only");

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

const timeSchema = z
  .object({
    days: nonNegativeIntSchema.optional(),
    hours: nonNegativeIntSchema.optional(),
    minutes: nonNegativeIntSchema.optional(),
    seconds: nonNegativeIntSchema.optional(),
  })
  .strict()
  .refine(
    value => Object.values(value).some(part => part !== undefined),
    "time must include at least one of days, hours, minutes, or seconds"
  );

const researchSchema = z
  .object({
    unlock_day: nonNegativeIntSchema,
    time: timeSchema,
    cost: completeResourceRecordSchema,
  })
  .strict();

const mobilisationSchema = z
  .object({
    time: timeSchema,
    cost: completeResourceRecordSchema,
    unit_limit: nonNegativeIntSchema.optional(),
  })
  .strict();

const upkeepSchema = z
  .object({
    cost: completeResourceRecordSchema,
  })
  .strict();

const unitLevelSchema = z
  .object({
    requirements: z.array(z.string().min(1)),
    research: researchSchema,
    mobilisation: mobilisationSchema,
    daily_upkeep: upkeepSchema,
  })
  .strict();

const levelsSchema = z
  .record(z.string().regex(/^[1-9]\d*$/, "Expected positive integer level key"), unitLevelSchema)
  .refine(levels => Object.keys(levels).length > 0, "levels must include at least one entry");

export function buildUnitCatalogSchema(enums: Enumerations) {
  const ResourceEnum = z.enum(enums.resources as [string, ...string[]]);
  const DoctrineEnum = z.enum(enums.doctrines as [string, ...string[]]);

  return z
    .object({
      schema_version: z.number().int().min(1),
      domain: z.literal("units"),
      resources: z.array(ResourceEnum).min(1),
      units: z.record(
        SnakeCaseId,
        z
          .object({
            name: z.string().min(1),
            category: z.string().min(1),
            doctrine: DoctrineEnum,
            levels: levelsSchema,
          })
          .strict()
      ),
    })
    .strict();
}

export type UnitCatalog = z.infer<ReturnType<typeof buildUnitCatalogSchema>>;

function normalizeUnitCatalogInput(input: unknown): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }

  const parsed = { ...(input as Record<string, unknown>) };
  const doctrines = parsed.units;

  if (doctrines && typeof doctrines === "object") {
    parsed.units = Object.fromEntries(
      Object.entries(doctrines as Record<string, unknown>).map(([unitId, unitValue]) => {
        if (!unitValue || typeof unitValue !== "object") {
          return [unitId, unitValue];
        }

        const normalizedUnit = { ...(unitValue as Record<string, unknown>) };
        if (typeof normalizedUnit.doctrine === "string") {
          normalizedUnit.doctrine = normalizedUnit.doctrine.trim().toLowerCase();
        }

        return [unitId, normalizedUnit];
      })
    );
  }

  return parsed;
}

export function parseUnitCatalog(
  input: unknown,
  enums: Enumerations,
  source = "unit catalog input"
): UnitCatalog {
  const result = buildUnitCatalogSchema(enums).safeParse(normalizeUnitCatalogInput(input));

  if (!result.success) {
    throw new Error(`Invalid unit catalog (${source}):\n${result.error.toString()}`);
  }

  return result.data;
}
