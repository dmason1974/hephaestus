import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { pool } from "../../db/pool.js";
import { finishRun, startRun, writeCountryEcoResult } from "../../db/eco-run-repository.js";
import { toAbsoluteHour } from "../../core/time.js";
import { runCityEcoBeam } from "../../engine/eco/city-eco-beam.js";
import { runProvinceEcoBeam } from "../../engine/eco/province-eco-beam.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioCoalitionPlan } from "../../scenarios/io/load-coalition-plan.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { getScenarioCountriesDir } from "../../scenarios/paths.js";
import type { CoalitionForcePlan } from "../../schemas/coalition-force-plan-schema.js";
import { scenarioTruceLengthDays } from "../../schemas/scenario-schema.js";

// ── Config ────────────────────────────────────────────────────────────────────

const scenarioId = process.env.ECO_SCENARIO ?? "elite/antarctica";
const planId = process.env.ECO_PLAN;
const countryFilter = process.env.ECO_COUNTRY ?? "all";
const beamWidth = parsePositiveInt(process.env.ECO_BEAM_WIDTH, 50);
const topN = parsePositiveInt(process.env.ECO_TOP_N, 3);

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Recorded on the run row so a result set can be traced back to the engine revision that produced it. */
function resolveGitCommit(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

// ── Data loading ──────────────────────────────────────────────────────────────

const plan: CoalitionForcePlan | undefined = planId
  ? loadScenarioCoalitionPlan(scenarioId, planId)
  : undefined;
const scenario = loadScenarioFile(scenarioId);
const buildings = loadBuildingsFile(path.resolve("data/buildings.yml"));

const truceDays = plan?.truce_days ?? scenarioTruceLengthDays(scenario) ?? 28;
const hoursToSimulate = truceDays * 24;

// ── Per-country analysis ──────────────────────────────────────────────────────

/**
 * Runs Unit 1's unconstrained beam for one country and persists it against the
 * open run. Beam configuration is unchanged from when this harness wrote HTML —
 * only the sink differs.
 */
async function analyseCountry(runId: number, countryId: string): Promise<void> {
  const country = loadScenarioCountry(scenarioId, countryId);
  const planCountry = plan?.countries[countryId];
  const status = planCountry?.status ?? (country.country.status as "homeland" | "occupied");
  const captureDay = planCountry?.capture_day ?? 4;
  const captureAbsHour = status === "occupied" ? toAbsoluteHour(captureDay, 0) : undefined;

  console.log(`[${countryId}] Running unconstrained eco beam (${country.cities.length} cities, status=${status})...`);

  const ecoResult = runCityEcoBeam(
    country,
    scenario,
    buildings,
    {
      hoursToSimulate,
      beamWidth,
      topN,
      unconstrained: true,
      academicHqEveryCity: true,
    },
    status,
    undefined,
    captureAbsHour
  );

  const provinceResults = runProvinceEcoBeam(country, scenario, buildings, {
    hoursToSimulate,
    cityStatus: status,
    // Tile distribution is a per-game observation, not a country property — see
    // countries.<id>.province_tiles in the plan schema. Absent when running
    // without a plan, or when this game's tiles haven't been observed yet for
    // this country: buildProvinceCohortsFromCountry then treats every province
    // as non-resource-producing and logs a warning (the "default" ranking).
    provinceTiles: planCountry?.province_tiles,
  });

  await writeCountryEcoResult({
    runId,
    countryId,
    countryName: country.country.name,
    doctrine: country.country.doctrine,
    status,
    captureDay: status === "occupied" ? captureDay : undefined,
    ecoResult,
    provinceResults,
  });

  console.log(
    `  → persisted ${ecoResult.cityResults.length} cities, ${provinceResults.length} province cohorts`
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

function resolveCountryIds(): string[] {
  if (countryFilter !== "all") return [countryFilter];
  if (plan) return Object.keys(plan.countries);
  // No plan: scan the countries directory for all country YAMLs
  const countriesDir = getScenarioCountriesDir(scenarioId);
  return fs
    .readdirSync(countriesDir)
    .filter(f => f.endsWith(".yml"))
    .map(f => path.basename(f, ".yml"))
    .sort();
}

const countryIds = resolveCountryIds();

try {
  const runId = await startRun({
    unit: "eco_plan",
    scenarioId,
    planId,
    truceDays,
    params: {
      countryFilter,
      beamWidth,
      topN,
      hoursToSimulate,
      unconstrained: true,
      academicHqEveryCity: true,
    },
    gitCommit: resolveGitCommit(),
  });

  console.log(`Run ${runId} — ${countryIds.length} country(ies), scenario ${scenarioId}${planId ? `, plan ${planId}` : ""}`);

  for (const countryId of countryIds) {
    await analyseCountry(runId, countryId);
  }

  await finishRun(runId);
  console.log(`Run ${runId} complete.`);
} catch (err) {
  console.error(
    "Failed. Is the SSH tunnel running (`npm run db:tunnel`) and the schema applied (`npm run db:migrate`)?"
  );
  throw err;
} finally {
  await pool.end();
}
