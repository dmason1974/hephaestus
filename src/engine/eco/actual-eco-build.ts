import type { Resource } from "../../core/constants.js";
import type { Country } from "../../schemas/country-schema.js";
import type { ScenarioFile } from "../../schemas/scenario-schema.js";
import { resolveScenarioHeadquartersCity } from "../../schemas/scenario-schema.js";
import type { BuildingsFile } from "../../schemas/building-schema.js";
import { runCityEcoBeam, computeWeightedScore } from "./city-eco-beam.js";
import type { CityEcoBeamConfig, CountryEcoBeamResult, CityEcoResult } from "./city-eco-beam.js";
import type { PlanWeights } from "../optimization/joint-city-optimizer.js";

/**
 * Selects which city (if any) should be allowed to build relocate_headquarters.
 * It's a per-country, at-most-once decision (moving the one HQ) — this picks the
 * single best candidate city (largest positive weighted-score delta vs not
 * relocating at all), or returns undefined if no city benefits. A scenario-level
 * manual override (`headquarters_city_by_country`) always takes precedence.
 *
 * Each candidate is evaluated by rerunning only that one city's beam
 * (`runCityEcoBeam`'s `cityFilter` scopes the run) — cheap, because the beam scores
 * each city against a fixed country-level baseline table computed once, not
 * against other cities' own builds.
 */
export function selectHeadquartersCity(
  country: Country,
  scenario: ScenarioFile,
  buildings: BuildingsFile,
  config: CityEcoBeamConfig,
  status: "homeland" | "occupied",
  captureAbsHour: number | undefined,
  planWeights: PlanWeights,
  baselineCityResults: CityEcoResult[]
): string | undefined {
  if (status !== "homeland") return undefined;

  const override = resolveScenarioHeadquartersCity(scenario, country.country.id);
  if (override) return override;

  const baselineByCity = new Map(baselineCityResults.map(r => [r.cityId, r]));
  let bestCityId: string | undefined;
  let bestDelta = 0;

  for (const city of country.cities) {
    if (city.capital) continue; // HQ is already there — nothing to relocate
    const baseline = baselineByCity.get(`${country.country.id}:${city.id}`);
    if (!baseline) continue;
    const baselineScore = computeWeightedScore(baseline.endingBalances, planWeights, city.resource as Resource);

    const trial = runCityEcoBeam(
      country, scenario, buildings,
      { ...config, resourceWeights: planWeights, hqCityId: city.id },
      status, city.id, captureAbsHour
    );
    const trialResult = trial.cityResults[0];
    if (!trialResult) continue;
    const trialScore = computeWeightedScore(trialResult.endingBalances, planWeights, city.resource as Resource);

    const delta = trialScore - baselineScore;
    if (delta > bestDelta) {
      bestDelta = delta;
      bestCityId = city.id;
    }
  }

  return bestCityId;
}

/**
 * Unit 1.5 — the "actual eco build". Reruns Unit 1's beam engine weighted by the
 * force plan's real resource footprint (planWeights, from computePlanWeights) and
 * capped so relocate_headquarters can be built in at most one city. This is what
 * should feed Unit 3's cost/income accounting — Unit 1's own unconstrained,
 * per-city-isolated run remains a purely theoretical reference and is untouched by
 * this module.
 */
export function runActualEcoBuild(
  country: Country,
  scenario: ScenarioFile,
  buildings: BuildingsFile,
  config: CityEcoBeamConfig,
  status: "homeland" | "occupied",
  captureAbsHour: number | undefined,
  planWeights: PlanWeights
): CountryEcoBeamResult {
  const baseline = runCityEcoBeam(
    country, scenario, buildings,
    { ...config, resourceWeights: planWeights },
    status, undefined, captureAbsHour
  );

  const hqCityId = selectHeadquartersCity(
    country, scenario, buildings, config, status, captureAbsHour, planWeights, baseline.cityResults
  );
  if (!hqCityId) return baseline;

  const hqRun = runCityEcoBeam(
    country, scenario, buildings,
    { ...config, resourceWeights: planWeights, hqCityId },
    status, hqCityId, captureAbsHour
  );
  const hqResult = hqRun.cityResults[0];
  if (!hqResult) return baseline;

  const bareHqCityId = `${country.country.id}:${hqCityId}`;
  const cityResults = baseline.cityResults.map(r => (r.cityId === bareHqCityId ? hqResult : r));

  return { scenarioAbsHour: baseline.scenarioAbsHour, cityResults };
}
