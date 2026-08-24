import { execFileSync } from "node:child_process";
import path from "node:path";

import { pool } from "../../db/pool.js";
import { finishRun, startRun, type RunCityMeta } from "../../db/eco-run-repository.js";
import { writeCountryForceResult } from "../../db/force-run-repository.js";
import { scenarioStartAbsoluteHour, toAbsoluteHour } from "../../core/time.js";
import { computeCountryForceProjection } from "../../engine/optimization/country-force-projection.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioCoalitionPlan } from "../../scenarios/io/load-coalition-plan.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadMergedUnitCatalogForScenario } from "../../scenarios/io/load-unit-catalog.js";

// ── Config ────────────────────────────────────────────────────────────────────
// Persists the PLAIN force projection — computeCountryForceProjection, unmodified,
// no eco credit, no beam search, infra chains built from scratch. Same computation
// iron-fp-plan.ts already runs; this harness just writes it to Postgres instead of
// tmp/*.html. Deliberately NOT eco-credited: getting this layer correct in
// isolation, testable on its own, comes before any eco-fitting is layered on top
// (that's a separate future step, not bundled into this harness).

const scenarioId = process.env.FPDB_SCENARIO ?? "elite/antarctica";
const planId = process.env.FPDB_PLAN ?? "pnth-v-iron-2026-aug";
const countryFilter = process.env.FPDB_COUNTRY ?? "all";
const maxRoLevel = parsePositiveInt(process.env.FPDB_MAX_RO, 5);

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveGitCommit(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

// ── Data loading ──────────────────────────────────────────────────────────────

const plan = loadScenarioCoalitionPlan(scenarioId, planId);
const scenario = loadScenarioFile(scenarioId);
const buildings = loadBuildingsFile(path.resolve("data/buildings.yml"));
const catalog = loadMergedUnitCatalogForScenario(scenarioId);
const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
const deadlineAbsHour = scenarioAbsHour + plan.truce_days * 24;

// ── Per-country analysis ───────────────────────────────────────────────────────

async function analyseCountry(runId: number, countryId: string): Promise<void> {
  const country = loadScenarioCountry(scenarioId, countryId);
  const doctrine = country.country.doctrine;
  const countryPlan = plan.countries[countryId];
  const status = countryPlan?.status ?? "homeland";
  const captureDay = countryPlan?.capture_day ?? 4;

  console.log(`[${countryId}] running plain force projection (status=${status})...`);

  const forceProjection = computeCountryForceProjection({
    country,
    doctrine,
    status,
    demands: countryPlan?.demands ?? [],
    scenario,
    buildings,
    catalog,
    scenarioAbsHour,
    deadlineAbsHour,
    truceDays: plan.truce_days,
    maxRoLevel,
    researchBufferHours: plan.research_buffer_hours,
    researchAsapPins: countryPlan?.research_asap_pins,
  });

  const cityMeta = new Map<string, RunCityMeta>(
    country.cities.map(c => [c.id, { cityId: c.id, cityName: c.name, resource: c.resource, capital: c.capital }])
  );

  await writeCountryForceResult({
    runId,
    countryId,
    countryName: country.country.name,
    doctrine,
    status,
    captureDay: status === "occupied" ? captureDay : undefined,
    forceProjection,
    cityMeta,
  });

  console.log(
    `  → persisted ${forceProjection.citySlots.length} city slot(s)`
    + (forceProjection.infeasible ? `, infeasible (${forceProjection.reason})` : "")
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

const countryIds = countryFilter === "all" ? Object.keys(plan.countries) : [countryFilter];

try {
  const runId = await startRun({
    unit: "force_projection",
    scenarioId,
    planId,
    truceDays: plan.truce_days,
    params: { countryFilter, maxRoLevel, ecoCredited: false },
    gitCommit: resolveGitCommit(),
  });

  console.log(`Run ${runId} — ${countryIds.length} country(ies), scenario ${scenarioId}, plan ${planId}`);

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
