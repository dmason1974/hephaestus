import { z } from "zod";
import type { Enumerations } from "./enums";

const SnakeCaseId = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/, "Expected snake_case id");

const NonNegativeInt = z.number().int().min(0);

export function buildCountrySchema(enums: Enumerations) {
  const ResourceEnum = z.enum(enums.resources as [string, ...string[]]);
  const DoctrineEnum = z.enum(enums.doctrines as [string, ...string[]]);

  const StartingSchema = z.object({
    army_base: NonNegativeInt,
    air_base: NonNegativeInt,
    naval_base: NonNegativeInt,
    arms_industry: NonNegativeInt,
    local_industry: NonNegativeInt,
    recruiting_office: NonNegativeInt,
  });

  const CitySchema = z.object({
    id: SnakeCaseId,
    name: z.string().min(1),
    capital: z.boolean(),
    resource: ResourceEnum,
    population: NonNegativeInt, // keep integer pop
    starting: StartingSchema,
  });

  const CountrySchema = z.object({
    version: z.number().int().min(1),
    country: z.object({
      id: SnakeCaseId,
      name: z.string().min(1),
      doctrine: DoctrineEnum,
    }),
    cities: z.array(CitySchema).min(1),
  });

  return CountrySchema;
}

export type Country = z.infer<ReturnType<typeof buildCountrySchema>>;