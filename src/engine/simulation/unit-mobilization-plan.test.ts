import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadUnitCatalog } from "../../scenarios/io/load-unit-catalog.js";
import { planMobilizationBuild } from "./unit-mobilization-plan.js";

function loadMergedUnitCatalog() {
  const navalCatalog = loadUnitCatalog(path.resolve("data/scenarios/standard/units/naval_units.yml"));
  const fighterCatalog = loadUnitCatalog(path.resolve("data/scenarios/standard/units/fighter_units.yml"));
  const infantryCatalog = loadUnitCatalog(path.resolve("data/scenarios/standard/units/infantry_units.yml"));
  const officerCatalog = loadUnitCatalog(path.resolve("data/scenarios/standard/units/officer_units.yml"));
  const seasonalCatalog = loadUnitCatalog(path.resolve("data/scenarios/standard/units/seasonal_units.yml"));

  return {
    ...navalCatalog,
    units: {
      ...navalCatalog.units,
      ...fighterCatalog.units,
      ...infantryCatalog.units,
      ...officerCatalog.units,
      ...seasonalCatalog.units,
    },
  };
}

function loadEliteFighterCatalog() {
  return loadUnitCatalog(path.resolve("data/scenarios/elite/units/fighter_units.yml"));
}

test("mobilization planner can force a higher recruiting office level than the unit minimum", () => {
  const result = planMobilizationBuild({
    catalog: loadMergedUnitCatalog(),
    buildings: loadBuildingsFile(),
    scenario: loadScenarioFile("elite/ww3"),
    demands: [
      { unitId: "air_superiority_fighter", count: 18, forcedRecruitingOfficeLevel: 2 },
    ],
  });

  assert.equal(result.cityProfiles[0]?.requiredRecruitingOfficeLevel, 2);
  assert.ok(result.segments.every(segment => segment.recruitingOfficeLevel === 2));
});

test("mobilization planner threads prerequisite research chains — SASF research plan includes ASF L1-L4", () => {
  // SASF requires air_superiority_fighter level 4 as a research prerequisite.
  // The planner must schedule ASF L1-L4 before SASF L1 in the research plan,
  // and all research must complete before the first SASF mobilisation starts.
  const scenario = loadScenarioFile("elite/ww3");
  const catalog = loadEliteFighterCatalog();

  const result = planMobilizationBuild({
    catalog,
    buildings: loadBuildingsFile(),
    scenario,
    demands: [{ unitId: "stealth_air_superiority_fighter", count: 3, doctrine: "western" }],
  });

  const researchUnitIds = new Set(result.researchPlan.segments.map(s => s.unitId));
  assert.ok(researchUnitIds.has("air_superiority_fighter"), "Research plan must include ASF as prerequisite");
  assert.ok(researchUnitIds.has("stealth_air_superiority_fighter"), "Research plan must include SASF");

  const asfLevels = result.researchPlan.segments
    .filter(s => s.unitId === "air_superiority_fighter")
    .map(s => s.level)
    .sort((a, b) => a - b);
  assert.ok(asfLevels.includes(4), "Research plan must include ASF L4 (direct prerequisite of SASF)");

  // ASF L4 must complete before SASF L1 starts
  const asfL4 = result.researchPlan.segments.find(s => s.unitId === "air_superiority_fighter" && s.level === 4);
  const sasfL1 = result.researchPlan.segments.find(s => s.unitId === "stealth_air_superiority_fighter" && s.level === 1);
  assert.ok(asfL4, "ASF L4 research must be scheduled");
  assert.ok(sasfL1, "SASF L1 research must be scheduled");
  assert.ok(
    asfL4.endAbsoluteHourExclusive <= sasfL1.startAbsoluteHour,
    `ASF L4 (ends ${asfL4.endAbsoluteHourExclusive}) must complete before SASF L1 starts (${sasfL1.startAbsoluteHour})`
  );

  // SASF research must complete before the first SASF mobilisation starts
  const firstSasfMobStart = Math.min(...result.segments
    .filter(s => s.unitId === "stealth_air_superiority_fighter")
    .map(s => s.startAbsoluteHour));
  assert.ok(
    sasfL1.endAbsoluteHourExclusive <= firstSasfMobStart,
    `SASF L1 research (ends ${sasfL1.endAbsoluteHourExclusive}) must complete before first SASF mob (starts ${firstSasfMobStart})`
  );
});
