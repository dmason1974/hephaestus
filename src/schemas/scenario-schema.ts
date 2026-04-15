import { z } from "zod";

import type { GameSpeed } from "../core/constants.js";

const cityStatusSchema = z.enum(["homeland", "occupied", "annexed"]);
const gameSpeedSchema = z.custom<GameSpeed>((value): value is GameSpeed => (
  value === "1x" ||
  value === "4x" ||
  value === "4x1.4" ||
  value === "10x"
), {
  message: "Invalid game speed",
});

const resourceAmountsSchema = z
  .object({
    supplies: z.number().min(0),
    components: z.number().min(0),
    fuel: z.number().min(0),
    rares: z.number().min(0),
    electronics: z.number().min(0),
    cash: z.number().min(0),
    manpower: z.number().min(0),
  })
  .strict();

export const scenarioFileSchema = z
  .object({
    schema_version: z.number(),
    domain: z.literal("scenario"),
    id: z.string().min(1),
    name: z.string().min(1),
    start: z.object({
      day: z.number(),
      hour: z.number(),
    }).strict(),
    truce_length_days: z.number().int().min(0).optional(),
    speed: gameSpeedSchema,
    starting_balance: resourceAmountsSchema,
    research: z.object({
      unlocked_through_day_at_start: z.number().int().min(0).optional(),
    }).strict().optional(),
    city_statuses: z.record(z.string().min(1), z.record(z.string().min(1), cityStatusSchema)).optional(),
    headquarters_city_by_country: z.record(z.string().min(1), z.string().min(1)).optional(),
  })
  .strict();

export type ScenarioFile = z.infer<typeof scenarioFileSchema>;

function normalizeScenarioInput(input: unknown): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }

  const parsed = { ...(input as Record<string, unknown>) };
  const startingBalance = parsed.starting_balance;

  if (
    startingBalance &&
    typeof startingBalance === "object" &&
    !("rares" in startingBalance) &&
    "rare" in startingBalance
  ) {
    const { rare, ...rest } = startingBalance as Record<string, unknown>;
    parsed.starting_balance = {
      ...rest,
      rares: rare,
    };
  }

  return parsed;
}

export function parseScenarioFile(input: unknown, source = "scenario input"): ScenarioFile {
  const result = scenarioFileSchema.safeParse(normalizeScenarioInput(input));

  if (!result.success) {
    throw new Error(`Invalid scenario data (${source}):\n${result.error.toString()}`);
  }

  return result.data;
}

export function resolveScenarioCityStatus(
  scenario: ScenarioFile,
  countryId: string,
  cityId: string
): z.infer<typeof cityStatusSchema> {
  return scenario.city_statuses?.[countryId]?.[cityId] ?? "homeland";
}

export function resolveScenarioHeadquartersCity(
  scenario: ScenarioFile,
  countryId: string
): string | undefined {
  return scenario.headquarters_city_by_country?.[countryId];
}

export function scenarioResearchUnlockedThroughDayAtStart(
  scenario: ScenarioFile
): number {
  return scenario.research?.unlocked_through_day_at_start ?? 0;
}

export function scenarioTruceLengthDays(
  scenario: ScenarioFile
): number | undefined {
  return scenario.truce_length_days;
}
