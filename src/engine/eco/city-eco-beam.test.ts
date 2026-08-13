import assert from "node:assert/strict";
import test from "node:test";

import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { runCityEcoBeam } from "./city-eco-beam.js";

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
