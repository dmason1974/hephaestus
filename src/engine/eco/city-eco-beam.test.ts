import assert from "node:assert/strict";
import test from "node:test";

import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { runCityEcoBeam, resimulateHourlyProductionWithExtraActions, evaluateEcoActionSequence, type EcoCandidateBuildingId } from "./city-eco-beam.js";

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

test("runCityEcoBeam bounded to a short horizon (hoursToSimulateByCity) finds a genuinely better sequence for that budget than replaying the unbounded-horizon winner's own prefix — proves the beam re-optimizes for the real budget rather than truncating an already-found longer answer", () => {
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const country = loadScenarioCountry(scenarioId, "italy");
  const city = country.cities.find(c => c.id === "rome")!;
  const shortHorizon = 80;

  const long = runCityEcoBeam(
    country, scenario, buildings,
    { hoursToSimulate: 600, beamWidth: 20, topN: 5, unconstrained: true },
    "homeland", "rome", undefined,
  );
  const longResult = long.cityResults[0];
  assert.ok(longResult);

  const short = runCityEcoBeam(
    country, scenario, buildings,
    { hoursToSimulate: shortHorizon, beamWidth: 20, topN: 5, unconstrained: true },
    "homeland", "rome", undefined,
  );
  const shortResult = short.cityResults[0];
  assert.ok(shortResult);
  const shortScore = shortResult.endingBalances[city.resource as keyof typeof shortResult.endingBalances];
  assert.equal(shortResult.hourlyCityProduction.length, shortHorizon, "the bounded run's production array should span exactly its own horizon, not the unbounded one");

  // What score would the long run's own winning sequence produce if simply replayed
  // and cut off at the short horizon — the "truncate an already-found longer
  // answer" approach this feature deliberately avoids?
  const truncatedTokens = longResult.bestActions
    .filter(a => (a.startHour ?? 0) < shortHorizon)
    .map(a => ({ buildingId: a.buildingId as EcoCandidateBuildingId, targetLevel: a.targetLevel }));
  const truncatedEval = evaluateEcoActionSequence(country, city, scenario, buildings, shortHorizon, "homeland", truncatedTokens, undefined);
  const truncatedScore = truncatedEval.endingBalances[city.resource as keyof typeof truncatedEval.endingBalances];

  assert.ok(
    shortScore > truncatedScore,
    `a beam genuinely bounded to the short horizon (${shortScore}) should outperform truncating the unbounded-horizon winner's own prefix (${truncatedScore}) — real fixture: Rome builds just arms_industry L1 when bounded, vs. the unbounded winner's prefix which also queues naval_base L2, a build that doesn't complete in time to pay off within 80h`,
  );
});

test("runActualEcoBuild-style config: hoursToSimulateByCity lets different cities in the same run simulate different horizons, with a city absent from the map falling back to the flat hoursToSimulate", () => {
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const country = loadScenarioCountry(scenarioId, "italy");

  const result = runCityEcoBeam(
    country, scenario, buildings,
    { hoursToSimulate: 400, hoursToSimulateByCity: { rome: 80 }, beamWidth: 10, topN: 3, unconstrained: true },
    "homeland", undefined, undefined,
  );

  const rome = result.cityResults.find(r => r.cityId === "italy:rome");
  const milan = result.cityResults.find(r => r.cityId === "italy:milan");
  assert.ok(rome && milan);
  assert.equal(rome.hourlyCityProduction.length, 80, "rome is listed in hoursToSimulateByCity and should be bounded to it");
  assert.equal(milan.hourlyCityProduction.length, 400, "milan is absent from hoursToSimulateByCity and should fall back to the flat hoursToSimulate");
  assert.ok(rome.lastEcoBuildCompletionAbsHour - result.scenarioAbsHour <= 80, "rome's own build sequence should never schedule anything past its bounded horizon");
});

test("scoreNativeResourceOnly changes which sequence wins (ranking) without changing the candidate pool (gating) — resourceWeights still forces recruiting_office first either way", () => {
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const country = loadScenarioCountry(scenarioId, "italy");
  const weights = { supplies: 1, cash: 1 };

  const weighted = runCityEcoBeam(
    country, scenario, buildings,
    { hoursToSimulate: 200, beamWidth: 20, topN: 5, unconstrained: true, resourceWeights: weights, scoreNativeResourceOnly: false },
    "homeland", "rome", undefined,
  );
  const native = runCityEcoBeam(
    country, scenario, buildings,
    { hoursToSimulate: 200, beamWidth: 20, topN: 5, unconstrained: true, resourceWeights: weights, scoreNativeResourceOnly: true },
    "homeland", "rome", undefined,
  );

  const weightedActions = weighted.cityResults[0].bestActions.map(a => `${a.buildingId}L${a.targetLevel}`);
  const nativeActions = native.cityResults[0].bestActions.map(a => `${a.buildingId}L${a.targetLevel}`);

  // Both still respect the RO-forcing/gating driven by resourceWeights (unaffected
  // by scoreNativeResourceOnly) — real fixture: weighted scoring stops after one
  // arms_industry level (cash cost outweighs the weighted benefit sooner), while
  // native-resource-only scoring keeps climbing arms_industry all the way, since it
  // ignores the cash cost entirely.
  assert.equal(weightedActions[0], "recruiting_officeL1");
  assert.equal(nativeActions[0], "recruiting_officeL1");
  assert.notDeepEqual(weightedActions, nativeActions, "the two scoring modes should pick different winning sequences for the same pool/config");
  assert.ok(nativeActions.length > weightedActions.length, "native-resource-only scoring should climb further since it's blind to the cash cost the weighted score penalises");
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
