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
    supplies: nonNegativeNumberSchema.optional(),
    components: nonNegativeNumberSchema.optional(),
    fuel: nonNegativeNumberSchema.optional(),
    rares: nonNegativeNumberSchema.optional(),
    electronics: nonNegativeNumberSchema.optional(),
    cash: nonNegativeNumberSchema.optional(),
    manpower: nonNegativeNumberSchema.optional(),
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

const doctrineResearchSchema = z
  .object({
    unlock_day: nonNegativeIntSchema,
    time: timeSchema,
    cost: completeResourceRecordSchema,
  })
  .strict();

const doctrineMobilisationSchema = z
  .object({
    time: timeSchema,
    cost: completeResourceRecordSchema,
    unit_limit: nonNegativeIntSchema.optional(),
  })
  .strict();

const doctrineUpkeepSchema = z
  .object({
    cost: completeResourceRecordSchema,
  })
  .strict();

export function buildUnitCatalogSchema(enums: Enumerations) {
  const ResourceEnum = z.enum(enums.resources as [string, ...string[]]);
  const DoctrineEnum = z.enum(enums.doctrines as [string, ...string[]]);
  const validDoctrines = enums.doctrines as string[];

  const doctrineKeySchema = z
    .string()
    .refine(k => validDoctrines.includes(k), `doctrine key must be one of: ${validDoctrines.join(", ")}`);

  const unitLevelSchema = z
    .object({
      requirements: z.array(z.string().min(1)),
      research: z
        .record(doctrineKeySchema, doctrineResearchSchema)
        .refine(r => Object.keys(r).length > 0, "research must include at least one doctrine"),
      mobilisation: z
        .record(doctrineKeySchema, doctrineMobilisationSchema)
        .refine(r => Object.keys(r).length > 0, "mobilisation must include at least one doctrine"),
      daily_upkeep: z
        .record(doctrineKeySchema, doctrineUpkeepSchema)
        .refine(r => Object.keys(r).length > 0, "daily_upkeep must include at least one doctrine"),
    })
    .strict();

  const levelsSchema = z
    .record(z.string().regex(/^[1-9]\d*$/, "Expected positive integer level key"), unitLevelSchema)
    .refine(levels => Object.keys(levels).length > 0, "levels must include at least one entry");

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
            doctrine: z.array(DoctrineEnum).min(1).max(3),
            levels: levelsSchema,
          })
          .strict()
      ),
    })
    .strict();
}

export type UnitCatalog = z.infer<ReturnType<typeof buildUnitCatalogSchema>>;

function normalizeLevelDoctrineBlock(
  block: Record<string, unknown>,
  _doctrines: string[]
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(block).map(([k, v]) => [k.trim().toLowerCase(), v])
  );
}

function normalizeLevel(
  level: Record<string, unknown>,
  doctrines: string[]
): Record<string, unknown> {
  const out = { ...level };
  const levelUnlockDay = out.unlock_day as number | undefined;

  // research normalization — three formats supported:
  // 1. Old flat: research has unlock_day/time/cost at root → spread into per-doctrine blocks
  // 2. Transitional: unlock_day at level root, research already per-doctrine → inject into each doctrine
  // 3. New: unlock_day inside each per-doctrine research block → leave alone
  if (out.research && typeof out.research === "object") {
    const r = out.research as Record<string, unknown>;
    if ("time" in r || "cost" in r || "unlock_day" in r) {
      // Case 1: old flat format
      const { unlock_day, time, cost } = r as {
        unlock_day?: number;
        time?: unknown;
        cost?: unknown;
      };
      const resolvedUnlockDay = unlock_day ?? levelUnlockDay;
      const entry: Record<string, unknown> = {};
      if (resolvedUnlockDay !== undefined) entry.unlock_day = resolvedUnlockDay;
      if (time !== undefined) entry.time = time;
      if (cost !== undefined) entry.cost = cost;
      out.research = Object.fromEntries(doctrines.map(d => [d, entry]));
    } else {
      // Cases 2 & 3: per-doctrine format — inject level-root unlock_day into doctrine blocks that lack one
      const normalized: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        const normKey = k.trim().toLowerCase();
        if (typeof v === "object" && v !== null) {
          const vObj = v as Record<string, unknown>;
          if (!("unlock_day" in vObj) && levelUnlockDay !== undefined) {
            normalized[normKey] = { unlock_day: levelUnlockDay, ...vObj };
          } else {
            normalized[normKey] = vObj;
          }
        } else {
          normalized[normKey] = v;
        }
      }
      out.research = normalized;
    }
  }

  // unlock_day no longer lives at the level root — remove it after normalization
  delete out.unlock_day;

  // mobilisation: old flat format has time + cost (+ unit_limit) at root
  if (out.mobilisation && typeof out.mobilisation === "object") {
    const m = out.mobilisation as Record<string, unknown>;
    if ("time" in m || "cost" in m) {
      const { time, cost, unit_limit } = m as {
        time?: unknown;
        cost?: unknown;
        unit_limit?: number;
      };
      const entry: Record<string, unknown> = {};
      if (time !== undefined) entry.time = time;
      if (cost !== undefined) entry.cost = cost;
      if (unit_limit !== undefined) entry.unit_limit = unit_limit;
      out.mobilisation = Object.fromEntries(doctrines.map(d => [d, entry]));
    } else {
      out.mobilisation = normalizeLevelDoctrineBlock(m, doctrines);
    }
  }

  // daily_upkeep: old flat format has cost at root
  if (out.daily_upkeep && typeof out.daily_upkeep === "object") {
    const u = out.daily_upkeep as Record<string, unknown>;
    if ("cost" in u) {
      const entry: Record<string, unknown> = { cost: u.cost };
      out.daily_upkeep = Object.fromEntries(doctrines.map(d => [d, entry]));
    } else {
      out.daily_upkeep = normalizeLevelDoctrineBlock(u, doctrines);
    }
  }

  return out;
}

function normalizeUnitCatalogInput(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;

  const parsed = { ...(input as Record<string, unknown>) };

  if (parsed.units && typeof parsed.units === "object") {
    parsed.units = Object.fromEntries(
      Object.entries(parsed.units as Record<string, unknown>).map(([unitId, unitValue]) => {
        if (!unitValue || typeof unitValue !== "object") return [unitId, unitValue];

        const unit = { ...(unitValue as Record<string, unknown>) };

        // Normalise doctrine to lowercase array
        if (typeof unit.doctrine === "string") {
          unit.doctrine = [unit.doctrine.trim().toLowerCase()];
        } else if (Array.isArray(unit.doctrine)) {
          unit.doctrine = unit.doctrine.map((d: unknown) =>
            typeof d === "string" ? d.trim().toLowerCase() : d
          );
        }

        const doctrines = (unit.doctrine as string[]) ?? [];

        // Normalise each level
        if (unit.levels && typeof unit.levels === "object") {
          unit.levels = Object.fromEntries(
            Object.entries(unit.levels as Record<string, unknown>).map(([lvlKey, lvlVal]) => {
              if (!lvlVal || typeof lvlVal !== "object") return [lvlKey, lvlVal];
              return [lvlKey, normalizeLevel(lvlVal as Record<string, unknown>, doctrines)];
            })
          );
        }

        return [unitId, unit];
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
