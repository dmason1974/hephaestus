import assert from "node:assert/strict";
import test from "node:test";

import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadMergedUnitCatalogForScenario } from "../../scenarios/io/load-unit-catalog.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import { optimizeForceProjection, formatSolution, formatSearchStats } from "./force-projection-optimizer.js";

test("optimizeForceProjection finds optimal solution for germany mobile_anti_air_vehicle", () => {
  // Load germany_mrl scenario data
  const scenario = loadScenarioFile("standard/ww3");
  const country = loadScenarioCountry("standard/ww3", "germany");
  const buildings = loadBuildingsFile();
  const unitCatalog = loadMergedUnitCatalogForScenario("standard/ww3");

  // 28-day deadline from scenario start
  const scenarioStart = scenarioStartAbsoluteHour(scenario);
  const deadlineHour = scenarioStart + (28 * 24);

  const result = optimizeForceProjection({
    unitId: "mobile_anti_air_vehicle",
    unitCount: 69,
    scenario,
    country,
    unitCatalog,
    buildings,
    deadlineHour,
    maxROLevel: 5,
    researchSlots: 2,
  });

  // Should find at least one feasible solution
  assert.ok(result.bestSolution !== null, "Should find a feasible solution");
  assert.ok(result.searchStats.feasibleSolutions > 0, "Should have feasible solutions");
  
  // Best solution should be feasible
  assert.equal(result.bestSolution.feasible, true);
  assert.equal(result.bestSolution.costBreakdown.feasible, true);
  
  // Should use some cities (at least 1, at most 7 for Germany)
  assert.ok(result.bestSolution.config.cities.length >= 1);
  assert.ok(result.bestSolution.config.cities.length <= 7);
  
  // Should have researched at least level 1
  assert.ok(result.bestSolution.maxLevelAchievable >= 1);
  assert.ok(result.bestSolution.researchSchedule.length >= 1);
  
  // Total units in batch allocation should equal requested count
  const totalUnits = Object.values(result.bestSolution.batchAllocation)
    .reduce((sum, count) => sum + count, 0);
  assert.equal(totalUnits, 69);
  
  // Cost should be positive and finite
  assert.ok(result.bestSolution.costBreakdown.total > 0);
  assert.ok(result.bestSolution.costBreakdown.total < Number.POSITIVE_INFINITY);
  
  // Search should have explored multiple configurations
  assert.ok(result.searchStats.configurationsGenerated > 0);
  assert.ok(result.searchStats.searchTimeMs >= 0);
  
  console.log("\n" + formatSearchStats(result));
  console.log("\n" + formatSolution(result.bestSolution));
});

test("optimizeForceProjection handles smaller unit count efficiently", () => {
  const scenario = loadScenarioFile("standard/ww3");
  const country = loadScenarioCountry("standard/ww3", "germany");
  const buildings = loadBuildingsFile();
  const unitCatalog = loadMergedUnitCatalogForScenario("standard/ww3");

  const scenarioStart = scenarioStartAbsoluteHour(scenario);
  const deadlineHour = scenarioStart + (28 * 24);

  const result = optimizeForceProjection({
    unitId: "tank_veteran",
    unitCount: 1,
    scenario,
    country,
    unitCatalog,
    buildings,
    deadlineHour,
    maxROLevel: 5,
  });

  assert.ok(result.bestSolution !== null);
  assert.equal(result.bestSolution.feasible, true);
  
  // For 1 unit, should use 1 city
  assert.equal(result.bestSolution.config.cities.length, 1);
  
  // Should allocate exactly 1 unit
  const totalUnits = Object.values(result.bestSolution.batchAllocation)
    .reduce((sum, count) => sum + count, 0);
  assert.equal(totalUnits, 1);
});

test("optimizeForceProjection returns sorted solutions by cost", () => {
  const scenario = loadScenarioFile("standard/ww3");
  const country = loadScenarioCountry("standard/ww3", "germany");
  const buildings = loadBuildingsFile();
  const unitCatalog = loadMergedUnitCatalogForScenario("standard/ww3");

  const scenarioStart = scenarioStartAbsoluteHour(scenario);
  const deadlineHour = scenarioStart + (28 * 24);

  const result = optimizeForceProjection({
    unitId: "mobile_anti_air_vehicle",
    unitCount: 10,
    scenario,
    country,
    unitCatalog,
    buildings,
    deadlineHour,
    maxROLevel: 3, // Limit search space for faster test
  });

  assert.ok(result.allSolutions.length > 0, "Should find at least one feasible solution");
  
  // Verify solutions are sorted by cost (ascending)
  for (let i = 1; i < result.allSolutions.length; i++) {
    assert.ok(
      result.allSolutions[i].costBreakdown.total >= result.allSolutions[i - 1].costBreakdown.total,
      `Solution ${i} should have cost >= solution ${i - 1}`
    );
  }
  
  // Best solution should be the first one
  if (result.bestSolution) {
    assert.equal(
      result.bestSolution.costBreakdown.total,
      result.allSolutions[0].costBreakdown.total
    );
  }
});

test("optimizeForceProjection handles country with no cities gracefully", () => {
  const scenario = loadScenarioFile("standard/ww3");
  const buildings = loadBuildingsFile();
  const unitCatalog = loadMergedUnitCatalogForScenario("standard/ww3");

  // Create a country with no cities
  const emptyCountry = {
    version: 1,
    country: {
      id: "empty",
      name: "Empty Country",
      doctrine: "western" as const,
    },
    cities: [],
    provinces: {
      total: 0,
      supplies: 0,
      components: 0,
      fuel: 0,
      rares: 0,
      electronics: 0,
    },
  };

  const scenarioStart = scenarioStartAbsoluteHour(scenario);
  const deadlineHour = scenarioStart + (28 * 24);

  const result = optimizeForceProjection({
    unitId: "mobile_anti_air_vehicle",
    unitCount: 10,
    scenario,
    country: emptyCountry,
    unitCatalog,
    buildings,
    deadlineHour,
  });

  assert.equal(result.bestSolution, null);
  assert.equal(result.allSolutions.length, 0);
  assert.equal(result.searchStats.configurationsGenerated, 0);
  assert.equal(result.searchStats.feasibleSolutions, 0);
});

test("formatSolution produces readable output", () => {
  const scenario = loadScenarioFile("standard/ww3");
  const country = loadScenarioCountry("standard/ww3", "germany");
  const buildings = loadBuildingsFile();
  const unitCatalog = loadMergedUnitCatalogForScenario("standard/ww3");

  const scenarioStart = scenarioStartAbsoluteHour(scenario);
  const deadlineHour = scenarioStart + (28 * 24);

  const result = optimizeForceProjection({
    unitId: "tank_veteran",
    unitCount: 1,
    scenario,
    country,
    unitCatalog,
    buildings,
    deadlineHour,
  });

  assert.ok(result.bestSolution !== null);
  
  const formatted = formatSolution(result.bestSolution);
  
  // Should contain key sections
  assert.ok(formatted.includes("Force Projection Solution"));
  assert.ok(formatted.includes("Configuration:"));
  assert.ok(formatted.includes("Research Schedule:"));
  assert.ok(formatted.includes("Unit Distribution:"));
  assert.ok(formatted.includes("Cost Breakdown:"));
  assert.ok(formatted.includes("TOTAL:"));
});

test("formatSearchStats produces readable output", () => {
  const scenario = loadScenarioFile("standard/ww3");
  const country = loadScenarioCountry("standard/ww3", "germany");
  const buildings = loadBuildingsFile();
  const unitCatalog = loadMergedUnitCatalogForScenario("standard/ww3");

  const scenarioStart = scenarioStartAbsoluteHour(scenario);
  const deadlineHour = scenarioStart + (28 * 24);

  const result = optimizeForceProjection({
    unitId: "tank_veteran",
    unitCount: 1,
    scenario,
    country,
    unitCatalog,
    buildings,
    deadlineHour,
  });

  const formatted = formatSearchStats(result);
  
  // Should contain key metrics
  assert.ok(formatted.includes("Search Statistics"));
  assert.ok(formatted.includes("Configurations Generated:"));
  assert.ok(formatted.includes("Feasible Solutions:"));
  assert.ok(formatted.includes("Search Time:"));
  assert.ok(formatted.includes("Best Solution Cost:"));
});

// Made with Bob
