import assert from "node:assert/strict";
import test from "node:test";

import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { runActualEcoBuild, selectHeadquartersCity } from "./actual-eco-build.js";
import { runCityEcoBeam } from "./city-eco-beam.js";

const scenarioId = "elite/antarctica";

test("runActualEcoBuild never relocates HQ when manpower dominates the plan weights (relocate_headquarters' cost is entirely manpower, with no manpower benefit)", () => {
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const country = loadScenarioCountry(scenarioId, "italy");

  const result = runActualEcoBuild(
    country, scenario, buildings,
    { hoursToSimulate: 300, beamWidth: 8, topN: 3, unconstrained: true },
    "homeland", undefined, { manpower: 1 },
  );

  assert.equal(result.cityResults.length, country.cities.length);
  const hqCities = result.cityResults.filter(r => r.bestActions.some(a => a.buildingId === "relocate_headquarters"));
  assert.equal(hqCities.length, 0, "no city should relocate HQ when the plan cares only about manpower — relocation costs manpower for zero manpower benefit");
});

test("runActualEcoBuild caps relocate_headquarters at exactly one city when the plan weights make it worthwhile", () => {
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const country = loadScenarioCountry(scenarioId, "italy");

  // Weight heavily toward the resource types most cities produce (supplies/components)
  // and cash, with a small but nonzero manpower weight — biases toward relocation
  // being worthwhile somewhere without being a manpower-dominated scenario.
  const result = runActualEcoBuild(
    country, scenario, buildings,
    { hoursToSimulate: 500, beamWidth: 8, topN: 3, unconstrained: true },
    "homeland", undefined, { supplies: 1, components: 1, cash: 1, manpower: 0.05 },
  );

  const hqCities = result.cityResults.filter(r => r.bestActions.some(a => a.buildingId === "relocate_headquarters"));
  assert.ok(hqCities.length <= 1, "relocate_headquarters must never be built in more than one city");
  // The capital already has the HQ — relocation (if any) must never target it.
  const capital = country.cities.find(c => c.capital);
  if (hqCities.length === 1 && capital) {
    assert.notEqual(hqCities[0].cityId, `${country.country.id}:${capital.id}`);
  }
});

test("selectHeadquartersCity respects a scenario-level manual override without running any trial beams", () => {
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const country = loadScenarioCountry(scenarioId, "italy");
  const overriddenScenario = { ...scenario, headquarters_city_by_country: { italy: "milan" } };

  const baseline = runCityEcoBeam(
    country, overriddenScenario, buildings,
    { hoursToSimulate: 100, beamWidth: 5, topN: 3, unconstrained: true, resourceWeights: { supplies: 1 } },
    "homeland", undefined, undefined,
  );

  const selected = selectHeadquartersCity(
    country, overriddenScenario, buildings,
    { hoursToSimulate: 100, beamWidth: 5, topN: 3, unconstrained: true },
    "homeland", undefined, { supplies: 1 }, baseline.cityResults,
  );

  assert.equal(selected, "milan");
});

test("runActualEcoBuild returns zero build actions for every city of an occupied country with empty plan weights", () => {
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const country = loadScenarioCountry(scenarioId, "norway");

  const result = runActualEcoBuild(
    country, scenario, buildings,
    { hoursToSimulate: 600, beamWidth: 8, topN: 3, unconstrained: true },
    "occupied", undefined, {},
  );

  assert.equal(result.cityResults.length, country.cities.length);
  for (const city of result.cityResults) {
    assert.deepEqual(city.bestActions, [], `${city.cityId} should build nothing — a demand-less occupied country must not fall back to unconstrained construction`);
  }
});

test("selectHeadquartersCity returns undefined for an occupied country", () => {
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const country = loadScenarioCountry(scenarioId, "italy");

  const selected = selectHeadquartersCity(
    country, scenario, buildings,
    { hoursToSimulate: 100, beamWidth: 5, topN: 3, unconstrained: true },
    "occupied", undefined, { supplies: 1 }, [],
  );

  assert.equal(selected, undefined);
});
