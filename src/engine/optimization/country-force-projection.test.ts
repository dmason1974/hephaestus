import assert from "node:assert/strict";
import test from "node:test";

import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCoalitionPlan } from "../../scenarios/io/load-coalition-plan.js";
import { loadMergedUnitCatalogForScenario } from "../../scenarios/io/load-unit-catalog.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import type { CityEcoResult } from "../eco/city-eco-beam.js";
import { runActualEcoBuild } from "../eco/actual-eco-build.js";
import { computeCountryForceProjection, classifyDemands, getBatchSize } from "./country-force-projection.js";
import { computePlanWeights } from "./joint-city-optimizer.js";

test("computeCountryForceProjection produces a feasible plan with a sane flip point for Russia", () => {
  const scenarioId = "elite/antarctica";
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const catalog = loadMergedUnitCatalogForScenario(scenarioId);
  const plan = loadScenarioCoalitionPlan(scenarioId, "pnth-v-iron-2026-aug");
  const country = loadScenarioCountry(scenarioId, "russia");
  const countryPlan = plan.countries.russia;

  const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
  const deadlineAbsHour = scenarioAbsHour + plan.truce_days * 24;

  const result = computeCountryForceProjection({
    country,
    doctrine: country.country.doctrine,
    status: countryPlan.status,
    demands: countryPlan.demands,
    scenario,
    buildings,
    catalog,
    scenarioAbsHour,
    deadlineAbsHour,
    truceDays: plan.truce_days,
    maxRoLevel: 5,
  });

  assert.equal(result.infeasible, false);
  assert.ok(result.citySlots.length > 0, "should allocate at least one city");

  for (const slot of result.citySlots) {
    assert.ok(Number.isFinite(slot.flipPointAbsHour));
    assert.ok(slot.flipPointAbsHour >= scenarioAbsHour, "flip point cannot precede scenario start");
    // Infra construction starts exactly at the flip point.
    if (slot.infraSteps.length > 0) {
      assert.equal(slot.infraSteps[0].startHour, slot.flipPointAbsHour);
    }
    // Mobilisation can only begin once infra (built starting at the flip point) is done.
    if (slot.mobSteps.length > 0) {
      assert.ok(slot.mobSteps[0].startAbsHour >= slot.flipPointAbsHour);
    }
  }

  // Cost buckets should sum to the reported total.
  const { infraRo, infraBuildings, mobilisation, upkeep, provinceMobilisation, provinceUpkeep, total } = result.costs;
  for (const r of ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"] as const) {
    const summed = (infraRo[r] ?? 0) + (infraBuildings[r] ?? 0) + (mobilisation[r] ?? 0) + (upkeep[r] ?? 0)
      + (provinceMobilisation[r] ?? 0) + (provinceUpkeep[r] ?? 0);
    assert.ok(Math.abs(summed - (total[r] ?? 0)) < 1e-6, `cost buckets should sum to total for ${r}`);
  }
});

test("computeCountryForceProjection returns reason 'no_demands' when the country has no demands", () => {
  const scenarioId = "elite/antarctica";
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const catalog = loadMergedUnitCatalogForScenario(scenarioId);
  const country = loadScenarioCountry(scenarioId, "russia");
  const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);

  const result = computeCountryForceProjection({
    country,
    doctrine: country.country.doctrine,
    status: "homeland",
    demands: [],
    scenario,
    buildings,
    catalog,
    scenarioAbsHour,
    deadlineAbsHour: scenarioAbsHour + 28 * 24,
    truceDays: 28,
    maxRoLevel: 5,
  });

  assert.equal(result.reason, "no_demands");
  assert.equal(result.infeasible, true);
  assert.equal(result.citySlots.length, 0);
});

test("classifyDemands routes units with no mobilisation data for the given doctrine to missingDataDemands, not launcherDemands", () => {
  // Synthetic minimal catalog rather than a real unit — real catalog data is
  // actively being filled in (e.g. fixed_wing_veteran and mobile_sam_launcher both
  // had this exact gap earlier in the same session this fix landed, then got their
  // missing doctrine's data added), so any real-unit fixture risks silently starting
  // to test nothing as the data gap it depends on gets closed. This regression test
  // is for the bug where missing-doctrine-data units were silently misclassified as
  // zero-mob-cost launcher platforms (same 0 returned by unitMobTimeHours for both
  // "no data" and "genuinely instant") and dropped from the plan without any warning.
  const catalog = {
    units: {
      gap_unit: {
        levels: {
          "1": {
            requirements: [],
            research: {},
            mobilisation: { western: { time: { hours: 1 }, cost: {} } },
            daily_upkeep: {},
          },
        },
      },
    },
  } as unknown as Parameters<typeof classifyDemands>[2];

  const result = classifyDemands([{ unitId: "gap_unit", count: 1 }], "eastern", catalog);

  assert.equal(result.missingDataDemands.length, 1);
  assert.equal(result.missingDataDemands[0].unitId, "gap_unit");
  assert.equal(result.launcherDemands.length, 0);
  assert.equal(result.activeDemands.length, 0);
});

test("classifyDemands still routes a genuine zero-mob-cost launcher platform to launcherDemands", () => {
  const scenarioId = "elite/antarctica";
  const catalog = loadMergedUnitCatalogForScenario(scenarioId);
  const plan = loadScenarioCoalitionPlan(scenarioId, "pnth-v-iron-2026-aug");
  const country = loadScenarioCountry(scenarioId, "india");
  const doctrine = country.country.doctrine;

  // India's demands include conventional_cruise_missile, a genuine zero-mob-time
  // launcher platform (real data exists, time is just 0) — must stay classified as
  // a launcher, not get swept into missingDataDemands.
  const result = classifyDemands(plan.countries.india.demands, doctrine, catalog);

  const cruiseMissileDemand = plan.countries.india.demands.find(d => d.unitId === "conventional_cruise_missile");
  assert.ok(cruiseMissileDemand, "fixture assumption: India demands conventional_cruise_missile");
  assert.ok(result.launcherDemands.some(d => d.unitId === "conventional_cruise_missile"));
  assert.ok(!result.missingDataDemands.some(d => d.unitId === "conventional_cruise_missile"));
});

test("computeCountryForceProjection credits eco-built levels and forces RO first when actualEcoResultsByCity is supplied", () => {
  const scenarioId = "elite/antarctica";
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const catalog = loadMergedUnitCatalogForScenario(scenarioId);
  const plan = loadScenarioCoalitionPlan(scenarioId, "pnth-v-iron-2026-aug");
  const country = loadScenarioCountry(scenarioId, "italy");
  const countryPlan = plan.countries.italy;
  const doctrine = country.country.doctrine;

  const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
  const deadlineAbsHour = scenarioAbsHour + plan.truce_days * 24;
  const hoursToSimulate = plan.truce_days * 24;

  const { activeDemands } = classifyDemands(countryPlan.demands, doctrine, catalog);
  const planWeights = computePlanWeights(
    activeDemands.map(d => ({ unitId: d.unitId, effectiveCount: Math.ceil(d.count / getBatchSize(d.unitId, catalog)) })),
    catalog, doctrine, plan.truce_days,
  );

  const baseline = computeCountryForceProjection({
    country, doctrine, status: countryPlan.status,
    demands: countryPlan.demands,
    scenario, buildings, catalog,
    scenarioAbsHour, deadlineAbsHour,
    truceDays: plan.truce_days,
    maxRoLevel: 5,
    planWeights,
  });

  const actualEco = runActualEcoBuild(
    country, scenario, buildings,
    { hoursToSimulate, beamWidth: 10, topN: 3, unconstrained: true },
    countryPlan.status, undefined, planWeights,
  );
  const actualEcoResultsByCity = new Map<string, CityEcoResult>(
    actualEco.cityResults.map(r => [r.cityId.slice(r.cityId.indexOf(":") + 1), r]),
  );

  const ecoCredited = computeCountryForceProjection({
    country, doctrine, status: countryPlan.status,
    demands: countryPlan.demands,
    scenario, buildings, catalog,
    scenarioAbsHour, deadlineAbsHour,
    truceDays: plan.truce_days,
    maxRoLevel: 5,
    planWeights,
    actualEcoResultsByCity,
  });

  assert.equal(ecoCredited.infeasible, false);
  assert.ok(ecoCredited.citySlots.length > 0);

  // relocate_headquarters must never appear in the actual eco build for more than
  // one city (structural cap — was previously built independently in every city).
  const hqBuildCities = actualEco.cityResults.filter(r =>
    r.bestActions.some(a => a.buildingId === "relocate_headquarters"),
  );
  assert.ok(hqBuildCities.length <= 1, "relocate_headquarters should be built in at most one city");

  // RO L1 must be the very first eco build action in every city (settled UAT rule).
  for (const cityResult of actualEco.cityResults) {
    assert.equal(cityResult.bestActions[0]?.buildingId, "recruiting_office");
    assert.equal(cityResult.bestActions[0]?.targetLevel, 1);
  }

  const baselineByCity = new Map(baseline.citySlots.map(s => [s.cityId, s]));

  for (const slot of ecoCredited.citySlots) {
    // RO must be the first infra step whenever RO is actually required (roLevel > 0).
    if (slot.roLevel > 0 && slot.infraSteps.length > 0) {
      assert.equal(slot.infraSteps[0].name.startsWith("recruiting office"), true);
    }
    // Infra construction starts exactly at the (eco-credited) flip point.
    if (slot.infraSteps.length > 0) {
      assert.equal(slot.infraSteps[0].startHour, slot.flipPointAbsHour);
    }

    // Eco-crediting should never make the chain longer than building from scratch —
    // city assignment (foldInDemands) is eco-unaware and identical given the same
    // planWeights, so this is a like-for-like comparison of the same city/unit/RO combo.
    const baselineSlot = baselineByCity.get(slot.cityId);
    if (baselineSlot) {
      const ecoTotalHours = slot.infraSteps.reduce((s, step) => s + step.durH, 0);
      const baselineTotalHours = baselineSlot.infraSteps.reduce((s, step) => s + step.durH, 0);
      assert.ok(
        ecoTotalHours <= baselineTotalHours + 1e-6,
        `eco-credited infra chain for ${slot.cityId} (${ecoTotalHours}h) should not exceed the formula-based chain (${baselineTotalHours}h)`,
      );
    }
  }
});
