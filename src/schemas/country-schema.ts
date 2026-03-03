import { z } from "zod";
import type { Enumerations } from "./enums-schema.js";

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
    local_industry: NonNegativeInt.optional().default(0),
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

function countCapitals(cities: Array<{ capital: boolean }>): number {
  return cities.reduce((acc, city) => acc + (city.capital ? 1 : 0), 0);
}

function assertUniqueIds(ids: string[], label: string) {
  const seen = new Set<string>();
  const dupes = new Set<string>();

  for (const id of ids) {
    if (seen.has(id)) {
      dupes.add(id);
    }
    seen.add(id);
  }

  if (dupes.size > 0) {
    throw new Error(`Duplicate ${label}: ${Array.from(dupes).join(", ")}`);
  }
}

export function parseCountry(
  input: unknown,
  enums: Enumerations,
  opts?: {
    source?: string;
    expectedCountryId?: string;
  }
): Country {
  const source = opts?.source ?? "country input";
  const result = buildCountrySchema(enums).safeParse(input);

  if (!result.success) {
    throw new Error(`Invalid country data (${source}):\n${result.error.toString()}`);
  }

  const country = result.data;
  const capitals = countCapitals(country.cities);
  if (capitals !== 1) {
    throw new Error(
      `Invalid country data (${source}): expected exactly 1 capital city, found ${capitals}`
    );
  }

  assertUniqueIds(country.cities.map(city => city.id), "city.id");

  if (opts?.expectedCountryId && country.country.id !== opts.expectedCountryId) {
    throw new Error(
      `Invalid country data (${source}): expected country.id "${opts.expectedCountryId}", got "${country.country.id}"`
    );
  }

  return country;
}
