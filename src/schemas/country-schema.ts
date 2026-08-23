import { z } from "zod";
import type { Enumerations } from "./enums-schema.js";

const SnakeCaseId = z
  .string()
  .min(1)
  .regex(/^[a-z0-9']+(?:_[a-z0-9']+)*$/, "Expected lowercase id with underscores/apostrophes only");

const NonNegativeInt = z.number().int().min(0);

export function buildCountrySchema(enums: Enumerations) {
  const ResourceEnum = z.enum(enums.resources as [string, ...string[]]);
  const DoctrineEnum = z.enum(enums.doctrines as [string, ...string[]]);

  const StartingSchema = z.object({
    air_base: NonNegativeInt,
    naval_base: NonNegativeInt,
    underground_bunkers: NonNegativeInt,
  });

  const CitySchema = z.object({
    id: SnakeCaseId,
    name: z.string().min(1),
    capital: z.boolean(),
    resource: ResourceEnum,
    population: NonNegativeInt, // keep integer pop
    starting: StartingSchema,
  });

  // Province resource-tile assignment is randomised per playthrough, so it is a
  // game-specific fact and lives in the coalition plan
  // (countries.<id>.province_tiles), not here. The province COUNT is a stable
  // property of the country and stays.
  const LEGACY_PROVINCE_TILE_KEYS = [
    "supplies",
    "components",
    "fuel",
    "rares",
    "electronics",
  ] as const;

  const ProvinceSchema = z
    .looseObject({ total: NonNegativeInt })
    .superRefine((value, ctx) => {
      const present = LEGACY_PROVINCE_TILE_KEYS.filter(
        key => (value as Record<string, unknown>)[key] !== undefined
      );
      if (present.length > 0) {
        ctx.addIssue({
          code: "custom",
          message:
            `province resource tiles (${present.join(", ")}) have moved to the coalition plan. ` +
            `Set them under countries.<id>.province_tiles in the plan YAML and delete these keys ` +
            `from the country YAML — tile assignment is randomised per game, so it is not a ` +
            `property of the country.`,
        });
      }
    })
    // Drop any other unrecognised keys so the parsed shape stays exactly { total }.
    .transform(value => ({ total: value.total }));

  const StartingBalanceSchema = z.object({
    supplies: z.number().min(0),
    components: z.number().min(0),
    fuel: z.number().min(0),
    rares: z.number().min(0),
    electronics: z.number().min(0),
    cash: z.number().min(0),
    manpower: z.number().min(0),
  }).partial();

  const CountrySchema = z.object({
    version: z.number().int().min(1),
    country: z.object({
      id: SnakeCaseId,
      name: z.string().min(1),
      doctrine: DoctrineEnum,
      status: z.enum(["homeland", "occupied"]).optional().default("homeland"),
    }),
    cities: z.array(CitySchema).min(1),
    provinces: ProvinceSchema.optional().default({ total: 0 }),
    starting_balance: StartingBalanceSchema.optional(),
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
