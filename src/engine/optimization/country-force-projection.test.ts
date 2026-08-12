import assert from "node:assert/strict";
import test from "node:test";

import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCoalitionPlan } from "../../scenarios/io/load-coalition-plan.js";
import { loadMergedUnitCatalogForScenario } from "../../scenarios/io/load-unit-catalog.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import { computeCountryForceProjection } from "./country-force-projection.js";

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
