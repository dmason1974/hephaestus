import assert from "node:assert/strict";
import test from "node:test";

import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadScenarioCoalitionPlan } from "../../scenarios/io/load-coalition-plan.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadMergedUnitCatalogForScenario } from "../../scenarios/io/load-unit-catalog.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import { classifyDemands, getBatchSize } from "./country-force-projection.js";
import {
  computePlanWeights,
  computeCoalitionPlanWeights,
  accumulateDemandResourceTotals,
  boostWeightsFromDeficit,
  foldInDemands,
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

  const totalA = accumulateDemandResourceTotals(countryA.demands, catalog, countryA.doctrine, truceDays);
  const totalB = accumulateDemandResourceTotals(countryB.demands, catalog, countryB.doctrine, truceDays);
  const expectedTotal: Record<string, number> = {};
  for (const t of [totalA, totalB]) {
    for (const [r, v] of Object.entries(t)) expectedTotal[r] = (expectedTotal[r] ?? 0) + (v ?? 0);
  }
  const maxVal = Math.max(...(Object.values(expectedTotal).filter(Boolean) as number[]), 1);
  for (const [r, v] of Object.entries(expectedTotal)) {
    if (v > 0) assert.ok(Math.abs((combined[r as keyof typeof combined] ?? 0) - v / maxVal) < 1e-9, `mismatch for ${r}`);
  }
});

test("boostWeightsFromDeficit only raises weight for resources in genuine deficit, never touches resources that are fine, and never exceeds 1.0", () => {
  const weights = { electronics: 0.15, fuel: 0.13, cash: 1.0 };
  const netPooledBalance = { electronics: -100, fuel: 50, cash: -1000 };
  const grossAvailable = { electronics: 200, fuel: 500, cash: 1000 };

  const boosted = boostWeightsFromDeficit(weights, netPooledBalance, grossAvailable);

  // electronics: deficit ratio 100/200 = 0.5 -> moves halfway from 0.15 to 1.0
  assert.ok(Math.abs(boosted.electronics! - (0.15 + 0.5 * 0.85)) < 1e-9);
  // fuel: net >= 0, completely untouched
  assert.equal(boosted.fuel, 0.13);
  // cash: deficit ratio 1000/1000 = 1.0 -> fully boosted to 1.0 (already was 1.0)
  assert.equal(boosted.cash, 1.0);
});

test("boostWeightsFromDeficit never produces a weight above 1.0 even with a severe deficit relative to gross available", () => {
  const weights = { rares: 0.03 };
  const netPooledBalance = { rares: -1000 };
  const grossAvailable = { rares: 10 }; // deficit far exceeds gross available
  const boosted = boostWeightsFromDeficit(weights, netPooledBalance, grossAvailable);
  assert.equal(boosted.rares, 1.0);
});

// ── foldInDemands: preferred_cities pinning ─────────────────────────────────

test("foldInDemands splits a preferredCities demand evenly across exactly those named cities, not the cost-driven search", () => {
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const catalog = loadMergedUnitCatalogForScenario(scenarioId);
  const country = loadScenarioCountry(scenarioId, "india");
  const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
  const deadlineAbsHour = scenarioAbsHour + 28 * 24;
  const moraleAtAbsHour = (absHour: number) => baselineHomelandMoraleOnDay(Math.floor(absHour / 24) + 1);
  const allCityIds = country.cities.map(c => c.id);

  const weights = computePlanWeights(
    [{ unitId: "stealth_air_superiority_fighter", effectiveCount: 34 }],
    catalog, "eastern", 28,
  );

  const result = foldInDemands(
    [{ unitId: "stealth_air_superiority_fighter", effectiveCount: 34, preferredCities: ["mumbai", "kolkata", "new_delhi"] }],
    allCityIds, catalog, buildings, "eastern", scenarioAbsHour, deadlineAbsHour, weights, 5, moraleAtAbsHour,
  );

  const usedCityIds = result.citySlots.map(s => s.cityId).sort();
  assert.deepEqual(usedCityIds, ["kolkata", "mumbai", "new_delhi"], "must open exactly the 3 preferred cities, no others");
  const totalAllocated = result.citySlots.reduce((s, slot) => s + slot.mobQueue.reduce((s2, e) => s2 + e.count, 0), 0);
  assert.equal(totalAllocated, 34, "full demand count must be allocated across the preferred cities");
  for (const slot of result.citySlots) {
    assert.equal(slot.primaryUnitId, "stealth_air_superiority_fighter");
  }
});

test("foldInDemands leaves demands without preferredCities on the unchanged cost-driven path, and pinned cities are excluded from their overflow city pool", () => {
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const catalog = loadMergedUnitCatalogForScenario(scenarioId);
  const country = loadScenarioCountry(scenarioId, "india");
  const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
  const deadlineAbsHour = scenarioAbsHour + 28 * 24;
  const moraleAtAbsHour = (absHour: number) => baselineHomelandMoraleOnDay(Math.floor(absHour / 24) + 1);
  const allCityIds = country.cities.map(c => c.id);

  const weights = computePlanWeights(
    [
      { unitId: "stealth_air_superiority_fighter", effectiveCount: 34 },
      { unitId: "uav", effectiveCount: 15 },
    ],
    catalog, "eastern", 28,
  );

  const result = foldInDemands(
    [
      { unitId: "stealth_air_superiority_fighter", effectiveCount: 34, preferredCities: ["mumbai", "kolkata", "new_delhi"] },
      { unitId: "uav", effectiveCount: 15 }, // unpinned — normal cost-driven fold-in
    ],
    allCityIds, catalog, buildings, "eastern", scenarioAbsHour, deadlineAbsHour, weights, 5, moraleAtAbsHour,
  );

  // Every SASF-primary slot must be one of the 3 preferred cities.
  const sasfCities = result.citySlots.filter(s => s.primaryUnitId === "stealth_air_superiority_fighter").map(s => s.cityId);
  for (const cid of sasfCities) {
    assert.ok(["mumbai", "kolkata", "new_delhi"].includes(cid), `unexpected SASF city ${cid}`);
  }
  // Any NEW dedicated uav-primary city must not be one of the 3 pinned cities
  // (they were removed from the overflow pool) — uav absorbed INTO a pinned
  // city (primaryUnitId still stealth_air_superiority_fighter) is fine/expected.
  const uavPrimaryCities = result.citySlots.filter(s => s.primaryUnitId === "uav").map(s => s.cityId);
  for (const cid of uavPrimaryCities) {
    assert.ok(!["mumbai", "kolkata", "new_delhi"].includes(cid), `uav should not open a NEW dedicated slot in a pinned city (${cid})`);
  }
});
