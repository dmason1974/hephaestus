import type { Country } from "../../schemas/country-schema.js";
import type { ScenarioFile } from "../../schemas/scenario-schema.js";
import type { BuildingsFile } from "../../schemas/building-schema.js";
import type { UnitCatalog } from "../../schemas/unit-schema.js";
import type { Demand, CountryPlan } from "../../schemas/coalition-force-plan-schema.js";
import type { CityEcoResult, CountryEcoBeamResult } from "../eco/city-eco-beam.js";
import { runActualEcoBuild } from "../eco/actual-eco-build.js";
import {
  classifyDemands,
  computeCountryForceProjection,
  getBatchSize,
  type CountryForceProjectionResult,
} from "./country-force-projection.js";
import { computePlanWeights, type PlanWeights } from "./joint-city-optimizer.js";

/**
 * Per-country identity/plan facts needed to run the eco-credited force projection —
 * mirrors resource-projection.ts's `CountryContext` shape (the harness still owns
 * loading/caching these; this module only consumes them).
 */
export type EcoCreditedForceProjectionContext = {
  countryId: string;
  country: Country;
  doctrine: string;
  status: "homeland" | "occupied";
  captureAbsHour: number | undefined;
  demands: Demand[];
  researchAsapPins: CountryPlan["research_asap_pins"];
};

export type EcoCreditedForceProjectionParams = {
  scenario: ScenarioFile;
  buildings: BuildingsFile;
  catalog: UnitCatalog;
  scenarioAbsHour: number;
  deadlineAbsHour: number;
  truceDays: number;
  maxRoLevel: number;
  hoursToSimulate: number;
  beamWidth: number;
  topN: number;
  researchBufferHours?: number;
};

export type EcoCreditedForceProjectionResult = {
  forceProjection: CountryForceProjectionResult;
  /** Unit 1.5's actual eco build — every city in the country, not just the ones
   *  force-projection assigned a demand to. */
  actualEco: CountryEcoBeamResult;
};

// Axis A: bounds Unit 1.5's eco beam search to each city's own real flip point
// instead of the flat full-truce-window. A city's flip point only comes out of
// computeCountryForceProjection, which itself consumes Unit 1.5's eco results — a
// genuine circularity — resolved by starting from a cheap, eco-independent seed
// (computeCountryForceProjection with actualEcoResultsByCity omitted, which falls
// back to the formula-based infra chain for every city) and refining it with up to
// MAX_HORIZON_ROUNDS beam passes, stopping once the flip-point estimate stabilizes.
export const MAX_HORIZON_ROUNDS = 2;
export const HORIZON_CONVERGENCE_TOLERANCE_HOURS = 6;

function deriveHorizonByCity(
  forceProjection: CountryForceProjectionResult,
  scenarioAbsHour: number,
  hoursToSimulate: number,
): Record<string, number> {
  const horizon: Record<string, number> = {};
  for (const slot of forceProjection.citySlots) {
    // Cities with no demand assigned never get a slot at all, so they simply never
    // appear here — runActualEcoBuild's hoursToSimulateByCity lookup falls back to
    // the flat hoursToSimulate for any city id absent from this map, which is
    // exactly right for a pure-eco city with no military-phase deadline to bound it.
    horizon[slot.cityId] = Math.max(1, Math.min(hoursToSimulate, Math.ceil(slot.flipPointAbsHour - scenarioAbsHour)));
  }
  return horizon;
}

/**
 * Unit 1.5 (actual eco build) + Unit 2 (force projection), run together as the one
 * circular-dependency-resolving convergence loop this actually is: a city's real
 * flip point depends on its eco credit, and its eco credit depends on being bounded
 * by its own flip point. Extracted out of resource-projection.ts's `analyseCountry`
 * so a second consumer (the Postgres-persisting force-plan-db harness) doesn't have
 * to duplicate this loop — one computation, multiple consumers.
 *
 * @param gateWeights Coalition-derived resource weights (see computeParityGateWeights)
 *   used ONLY to gate which cities' candidate pools include
 *   arms_industry/air_base/naval_base (Axis B), and to drive the eco beam's own
 *   weighted ranking.
 */
export function computeEcoCreditedForceProjection(
  ctx: EcoCreditedForceProjectionContext,
  params: EcoCreditedForceProjectionParams,
  gateWeights: PlanWeights,
): EcoCreditedForceProjectionResult {
  const { country, doctrine, status, captureAbsHour, demands, researchAsapPins } = ctx;
  const {
    scenario, buildings, catalog, scenarioAbsHour, deadlineAbsHour, truceDays,
    maxRoLevel, hoursToSimulate, beamWidth, topN, researchBufferHours,
  } = params;

  const { activeDemands } = classifyDemands(demands, doctrine, catalog);
  // Unit 2's fold-in (computeCountryForceProjection below) keeps using this
  // country's own plan weights — a genuinely country-scoped decision (RO
  // level/city assignment cost comparisons), unrelated to shared-pool priorities.
  const planWeights = computePlanWeights(
    activeDemands.map(d => ({ unitId: d.unitId, effectiveCount: Math.ceil(d.count / getBatchSize(d.unitId, catalog)) })),
    catalog, doctrine, truceDays,
  );

  const baseForceProjectionInput = {
    country, doctrine, status,
    demands,
    scenario, buildings, catalog,
    scenarioAbsHour, deadlineAbsHour,
    truceDays,
    maxRoLevel,
    planWeights,
    researchBufferHours,
    researchAsapPins,
  };

  // Round 0 (seed): no eco beam run at all — computeCountryForceProjection falls
  // back to the formula-based infra chain per city, giving a real, research-aware
  // flip-point estimate at zero beam-search cost.
  const seedProjection = computeCountryForceProjection({ ...baseForceProjectionInput, actualEcoResultsByCity: undefined });
  let horizonByCity = deriveHorizonByCity(seedProjection, scenarioAbsHour, hoursToSimulate);

  // Unit 1.5: the "actual eco build" — Unit 1's beam engine, bounded per-city to
  // horizonByCity (Axis A — running the search itself over the real budget, not
  // truncating an already-found longer-budget answer) and scored by gateWeights
  // (Axis B) exactly as the old weighted mode did: a weighted sum across ALL
  // resources, not just the city's own native one. This matters — an earlier
  // version of this feature tried scoreNativeResourceOnly (score by native resource
  // alone, gateWeights only gating which buildings are even considered) and
  // verified empirically WORSE on the real coalition plan (utilization spread
  // widened, not narrowed): once a building clears the binary gate, native-only
  // scoring has zero awareness of what it costs in OTHER resources, so a fuel city
  // climbing arms_industry would happily burn electronics/rares along the way. The
  // weighted score keeps that cross-resource cost visible in the ranking itself.
  // gateWeights is what fixes the two diagnosed problems in the OLD weighted
  // formula (cash/manpower excluded; derived from real parity, not raw demand cost)
  // — reusing the SAME mechanism the old code already relied on for cross-resource
  // discipline, not a new one. relocate_headquarters is capped to at most one city.
  // Unit 1's own unconstrained/theoretical run (smoke:eco-plan) is intentionally
  // not used here — it's a per-city-isolated reference ceiling, not the real plan.
  let actualEco = runActualEcoBuild(
    country, scenario, buildings,
    { hoursToSimulate, hoursToSimulateByCity: horizonByCity, beamWidth, topN, unconstrained: true },
    status, captureAbsHour, gateWeights,
  );
  let actualEcoResultsByCity = new Map<string, CityEcoResult>(
    actualEco.cityResults.map(r => [r.cityId.slice(r.cityId.indexOf(":") + 1), r]),
  );
  let forceProjection = computeCountryForceProjection({ ...baseForceProjectionInput, actualEcoResultsByCity });

  // Refine the horizon: eco investment credited by round 1 can shrink a city's
  // remaining military chain, pulling its real flip point later than the seed
  // estimated — re-run the beam against the refined bound if it moved meaningfully.
  for (let round = 1; round < MAX_HORIZON_ROUNDS; round++) {
    const newHorizonByCity = deriveHorizonByCity(forceProjection, scenarioAbsHour, hoursToSimulate);
    const cityIds = new Set([...Object.keys(horizonByCity), ...Object.keys(newHorizonByCity)]);
    const maxDelta = Math.max(0, ...[...cityIds].map(id => Math.abs((newHorizonByCity[id] ?? hoursToSimulate) - (horizonByCity[id] ?? hoursToSimulate))));
    if (maxDelta < HORIZON_CONVERGENCE_TOLERANCE_HOURS) break;

    horizonByCity = newHorizonByCity;
    actualEco = runActualEcoBuild(
      country, scenario, buildings,
      { hoursToSimulate, hoursToSimulateByCity: horizonByCity, beamWidth, topN, unconstrained: true },
      status, captureAbsHour, gateWeights,
    );
    actualEcoResultsByCity = new Map<string, CityEcoResult>(
      actualEco.cityResults.map(r => [r.cityId.slice(r.cityId.indexOf(":") + 1), r]),
    );
    forceProjection = computeCountryForceProjection({ ...baseForceProjectionInput, actualEcoResultsByCity });
  }

  return { forceProjection, actualEco };
}
