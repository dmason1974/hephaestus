import assert from "node:assert/strict";
import test from "node:test";

import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { scenarioResearchUnlockedThroughDayAtStart } from "../../schemas/scenario-schema.js";
import { loadScenarioCoalitionPlan } from "../../scenarios/io/load-coalition-plan.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadMergedUnitCatalogForScenario } from "../../scenarios/io/load-unit-catalog.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import { classifyDemands, getBatchSize } from "./country-force-projection.js";
import {
  computePlanWeights,
  computeCoalitionPlanWeights,
  accumulateDemandResourceTotals,
  computeParityGateWeights,
  WEIGHT_FORMULA_EXCLUDED_RESOURCES,
  foldInDemands,
  estimateBestNewCityConfig,
} from "./joint-city-optimizer.js";
import { baselineHomelandMoraleOnDay } from "../economy/morale.js";

const scenarioId = "elite/antarctica";

test("computeCoalitionPlanWeights: a resource barely used by one country's own demands can still get a meaningfully higher coalition-wide weight than that country's own weight, when other countries consume it heavily", () => {
  const plan = loadScenarioCoalitionPlan(scenarioId, "pnth-v-iron-2026-aug");
  const catalog = loadMergedUnitCatalogForScenario(scenarioId);

  function demandsFor(countryId: string) {
    const country = loadScenarioCountry(scenarioId, countryId);
    const doctrine = country.country.doctrine;
    const { activeDemands } = classifyDemands(plan.countries[countryId].demands, doctrine, catalog);
    return {
      doctrine,
      demands: activeDemands.map(d => ({ unitId: d.unitId, effectiveCount: Math.ceil(d.count / getBatchSize(d.unitId, catalog)) })),
    };
  }

  const italy = demandsFor("italy");
  const india = demandsFor("india");
  const japan = demandsFor("japan");

  const italyOwnWeights = computePlanWeights(italy.demands, catalog, italy.doctrine, plan.truce_days);
  const coalitionWeights = computeCoalitionPlanWeights([italy, india, japan], catalog, plan.truce_days);

  // Fixture assumption (matches the real plan): Italy's own demand (MRL/MAAV/Tank
  // Veteran) is electronics-light, while India/Japan's (SASF/UAV-heavy) is
  // electronics-heavy — this is the exact real-world case that motivated the fix
  // (Italy's Messina, an electronics-tile city, under-investing under its own
  // country's narrow weight even though the coalition needs electronics badly).
  assert.ok((italyOwnWeights.electronics ?? 0) > 0, "fixture assumption: Italy's own weight for electronics is nonzero but small");
  assert.ok(
    (coalitionWeights.electronics ?? 0) > (italyOwnWeights.electronics ?? 0),
    `coalition-wide electronics weight (${coalitionWeights.electronics}) should exceed Italy's own narrow weight (${italyOwnWeights.electronics})`,
  );
});

test("computeCoalitionPlanWeights normalises the SUM of every country's raw demand totals (not an average or a per-country weight sum)", () => {
  const scenarioIdLocal = scenarioId;
  const catalog = loadMergedUnitCatalogForScenario(scenarioIdLocal);
  const truceDays = 28;

  const countryA = { doctrine: "western", demands: [{ unitId: "multiple_rocket_launcher", effectiveCount: 10 }] };
  const countryB = { doctrine: "european", demands: [{ unitId: "mobile_anti_air_vehicle", effectiveCount: 10 }] };

  const combined = computeCoalitionPlanWeights([countryA, countryB], catalog, truceDays);

  const totalA = accumulateDemandResourceTotals(countryA.demands, catalog, countryA.doctrine, truceDays, {}, WEIGHT_FORMULA_EXCLUDED_RESOURCES);
  const totalB = accumulateDemandResourceTotals(countryB.demands, catalog, countryB.doctrine, truceDays, {}, WEIGHT_FORMULA_EXCLUDED_RESOURCES);
  const expectedTotal: Record<string, number> = {};
  for (const t of [totalA, totalB]) {
    for (const [r, v] of Object.entries(t)) expectedTotal[r] = (expectedTotal[r] ?? 0) + (v ?? 0);
  }
  const maxVal = Math.max(...(Object.values(expectedTotal).filter(Boolean) as number[]), 1);
  for (const [r, v] of Object.entries(expectedTotal)) {
    if (v > 0) assert.ok(Math.abs((combined[r as keyof typeof combined] ?? 0) - v / maxVal) < 1e-9, `mismatch for ${r}`);
  }
});

test("computeParityGateWeights ranks resources by cost/income utilization, highest getting weight 1.0", () => {
  // electronics: 150% utilization (cost exceeds income) — highest, gets weight 1.0.
  // supplies: 110% utilization — lower than electronics, gets a proportionally lower weight.
  const cost = { electronics: 1500, supplies: 1100 };
  const income = { electronics: 1000, supplies: 1000 };

  const weights = computeParityGateWeights(cost, income, ["electronics", "supplies"]);

  assert.equal(weights.electronics, 1.0);
  assert.ok(Math.abs((weights.supplies ?? 0) - 1.1 / 1.5) < 1e-9);
  assert.ok((weights.supplies ?? 0) < (weights.electronics ?? 0));
});

test("computeParityGateWeights is bidirectional: a resource's gate weight DECREASES relative to others once its income improves, unlike a boost-only correction that can only ever raise a weight", () => {
  const cost = { electronics: 1500, supplies: 1100 };
  const before = computeParityGateWeights(cost, { electronics: 1000, supplies: 1000 }, ["electronics", "supplies"]);

  // electronics' income improves a lot (production came online) — its utilization
  // drops from 150% to 75%, now BELOW supplies' still-110% utilization.
  const after = computeParityGateWeights(cost, { electronics: 2000, supplies: 1000 }, ["electronics", "supplies"]);

  assert.ok((after.electronics ?? 0) < (before.electronics ?? 0), "electronics' gate weight should fall as its income improves");
  assert.equal(after.supplies, 1.0, "supplies is now the highest-utilization resource and should be re-based to 1.0");
});

test("computeParityGateWeights treats zero income with positive cost as maximal (1.0) utilization, and zero cost as zero utilization", () => {
  const weights = computeParityGateWeights({ electronics: 500, fuel: 0 }, { electronics: 0, fuel: 1000 }, ["electronics", "fuel"]);
  assert.equal(weights.electronics, 1.0);
  assert.equal(weights.fuel, 0);
});

// ── estimateBestNewCityConfig: ceiling-level feasibility gate ───────────────

test("estimateBestNewCityConfig rejects a single-city config that a flat-L1 duration would have wrongly accepted, once the real (higher-level) duration doesn't fit", () => {
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const catalog = loadMergedUnitCatalogForScenario(scenarioId);
  const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
  const unlockedThroughDayAtStart = scenarioResearchUnlockedThroughDayAtStart(scenario);
  const moraleAtAbsHour = (absHour: number) => baselineHomelandMoraleOnDay(Math.floor(absHour / 24) + 1);
  const weights = computePlanWeights([{ unitId: "mobile_sam_launcher", effectiveCount: 15 }], catalog, "eastern", 28);

  // A window sized between flat-L1's total (15 units x ~14h = ~210h) and the
  // ceiling level's total (15 units x ~18h = ~270h) at RO2: wide enough that
  // the OLD flat-L1 gate would have accepted 1 city, tight enough that the
  // real (research-level-aware) duration genuinely doesn't fit.
  const wideDeadline = scenarioAbsHour + 5000; // establish infraOpenHour at RO2 without hitting window<=0
  const wide = estimateBestNewCityConfig(
    "mobile_sam_launcher", 15, 2, 2, 1, scenarioAbsHour, wideDeadline,
    catalog, buildings, "eastern", moraleAtAbsHour, weights, unlockedThroughDayAtStart,
  );
  assert.ok(wide, "fixture assumption: a wide deadline must be feasible");
  const infraOpenHour = wide!.infraOpenHour;

  const tightDeadline = infraOpenHour + 240; // between the two totals above
  const tight = estimateBestNewCityConfig(
    "mobile_sam_launcher", 15, 2, 2, 1, scenarioAbsHour, tightDeadline,
    catalog, buildings, "eastern", moraleAtAbsHour, weights, unlockedThroughDayAtStart,
  );

  assert.equal(tight, null, "the ceiling-level gate should reject this single-city config, not accept it using flat-L1 duration");
});
