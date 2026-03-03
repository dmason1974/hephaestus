import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

import { projectRoot } from "./enums.js";

const ResourceAmountsSchema = z
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

const ScenarioFileSchema = z
  .object({
    schema_version: z.number(),
    domain: z.literal("scenario"),
    id: z.string().min(1),
    name: z.string().min(1),
    start: z.object({
      day: z.number(),
      hour: z.number(),
    }).strict(),
    speed: z.enum(["1x", "4x", "10x"]),
    starting_balance: ResourceAmountsSchema,
  })
  .strict();

export type ScenarioFile = z.infer<typeof ScenarioFileSchema>;

export function getScenarioPath(scenarioId: string) {
  return path.join(projectRoot(), "data", "scenarios", scenarioId, "scenario.yml");
}

export function getScenarioCountriesDir(scenarioId: string) {
  return path.join(projectRoot(), "data", "scenarios", scenarioId, "countries");
}

export function getScenarioCountryPath(scenarioId: string, countryId: string) {
  return path.join(getScenarioCountriesDir(scenarioId), `${countryId}.yml`);
}

export function loadScenarioFile(scenarioId: string): ScenarioFile {
  const scenarioPath = getScenarioPath(scenarioId);
  const raw = fs.readFileSync(scenarioPath, "utf8");
  const parsed = YAML.parse(raw) as Record<string, unknown>;

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

  return ScenarioFileSchema.parse(parsed);
}
