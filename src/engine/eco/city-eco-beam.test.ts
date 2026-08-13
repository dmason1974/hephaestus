import assert from "node:assert/strict";
import test from "node:test";

import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { runCityEcoBeam, resimulateHourlyProductionWithExtraActions } from "./city-eco-beam.js";

const scenarioId = "elite/antarctica";

test("runCityEcoBeam forces recruiting_office L1 as the first action when resourceWeights is supplied", () => {
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const country = loadScenarioCountry(scenarioId, "italy");

  const result = runCityEcoBeam(
    country, scenario, buildings,
    { hoursToSimulate: 200, beamWidth: 10, topN: 3, unconstrained: true, resourceWeights: { supplies: 1, cash: 0.5 } },
    "homeland", "rome", undefined,
  );

  const rome = result.cityResults[0];
  assert.ok(rome);
  assert.equal(rome.bestActions[0]?.buildingId, "recruiting_office");
  assert.equal(rome.bestActions[0]?.targetLevel, 1);
  assert.equal(rome.bestActions[0]?.startHour, 0);
});

test("runCityEcoBeam does not force RO for Unit 1's unconstrained theoretical run (no resourceWeights)", () => {
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const country = loadScenarioCountry(scenarioId, "italy");

  const result = runCityEcoBeam(
    country, scenario, buildings,
    { hoursToSimulate: 200, beamWidth: 10, topN: 3, unconstrained: true },
    "homeland", "rome", undefined,
  );

  const rome = result.cityResults[0];
  assert.ok(rome);
  const hasRO = rome.bestActions.some(a => a.buildingId === "recruiting_office");
  assert.equal(hasRO, false, "RO is never chosen organically for a supplies city under native-resource-only scoring — Unit 1's theoretical output must be untouched by the RO-forcing fix");
});

test("runCityEcoBeam never builds relocate_headquarters when hqCityId is absent, even with resourceWeights", () => {
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const country = loadScenarioCountry(scenarioId, "italy");

  const result = runCityEcoBeam(
    country, scenario, buildings,
    { hoursToSimulate: 400, beamWidth: 10, topN: 3, unconstrained: true, resourceWeights: { supplies: 1, manpower: 0.3, cash: 1 } },
    "homeland", "milan", undefined,
  );

  const milan = result.cityResults[0];
  assert.ok(milan);
  assert.equal(milan.bestActions.some(a => a.buildingId === "relocate_headquarters"), false);
});

test("runCityEcoBeam never builds relocate_headquarters in a city that isn't the designated hqCityId", () => {
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const country = loadScenarioCountry(scenarioId, "italy");

  // hqCityId points at Milan; Naples must never consider relocate_headquarters.
  const result = runCityEcoBeam(
    country, scenario, buildings,
    { hoursToSimulate: 400, beamWidth: 10, topN: 3, unconstrained: true, resourceWeights: { supplies: 1, manpower: 0.3, cash: 1 }, hqCityId: "milan" },
    "homeland", "naples", undefined,
  );

  const naples = result.cityResults[0];
  assert.ok(naples);
  assert.equal(naples.bestActions.some(a => a.buildingId === "relocate_headquarters"), false);
});

test("runCityEcoBeam builds nothing for an occupied country when resourceWeights is supplied (even empty)", () => {
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const country = loadScenarioCountry(scenarioId, "madagascar");

  const result = runCityEcoBeam(
    country, scenario, buildings,
    { hoursToSimulate: 400, beamWidth: 10, topN: 3, unconstrained: true, resourceWeights: {} },
    "occupied", undefined, undefined,
  );

  for (const city of result.cityResults) {
    assert.deepEqual(city.bestActions, [], `${city.cityId} should have zero build actions`);
  }
});

test("runCityEcoBeam still builds annex_city unconstrained for an occupied country with no resourceWeights key (Unit 1's theoretical ceiling stays untouched)", () => {
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const country = loadScenarioCountry(scenarioId, "madagascar");

  const result = runCityEcoBeam(
    country, scenario, buildings,
    { hoursToSimulate: 400, beamWidth: 10, topN: 3, unconstrained: true },
    "occupied", undefined, undefined,
  );

  for (const city of result.cityResults) {
    assert.ok(
      city.bestActions.some(a => a.buildingId === "annex_city"),
      `${city.cityId} should still build annex_city when resourceWeights is entirely absent`,
    );
  }
});

test("resimulateHourlyProductionWithExtraActions credits an extra recruiting_office level-up's manpower bonus starting at its own completion hour", () => {
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const country = loadScenarioCountry(scenarioId, "italy");
  const hoursToSimulate = 200;

  // Base case: no eco actions at all (organic beam chose nothing).
  const withoutBackfill = resimulateHourlyProductionWithExtraActions(
    country, "rome", "homeland", scenario, buildings, [], [], hoursToSimulate, 0,
  );

  // recruiting_office L0->L1 takes 0.5h — a single-level step, matching exactly
  // what computeEcoBackfill always produces (one action per level increment).
  const extraAction = { cityId: "italy:rome", buildingId: "recruiting_office" as const, targetLevel: 1, startHour: 0 };
  const withBackfill = resimulateHourlyProductionWithExtraActions(
    country, "rome", "homeland", scenario, buildings, [], [extraAction], hoursToSimulate, 0,
  );

  // RO L1 completes within the first hour either way, so production should differ
  // from hour 1 onward — RO L1's manpower_bonus_pct/flat_bonus now applies.
  assert.ok(
    withBackfill[5].manpower > withoutBackfill[5].manpower,
    `expected higher manpower production once RO L1 completes (${withBackfill[5].manpower} vs ${withoutBackfill[5].manpower})`,
  );
  // No other resource should regress just because RO L1 was added.
  for (const r of ["supplies", "components", "fuel", "rares", "electronics", "cash"] as const) {
    assert.ok(withBackfill[5][r] >= withoutBackfill[5][r], `${r} should not regress from adding RO L1`);
  }
});
