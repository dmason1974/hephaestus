import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { toAbsoluteHour } from "../../core/time.js";
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

test("mobilization planner splits capped units into the lowest feasible mobilisation levels", () => {
  const result = planMobilizationBuild({
    catalog: loadMergedUnitCatalog(),
    buildings: loadBuildingsFile(),
    scenario: loadScenarioFile("elite/ww3"),
    demands: [
      { unitId: "naval_veteran", count: 1 },
      { unitId: "fixed_wing_veteran", count: 1, researchTargetLevel: 6 },
      { unitId: "epic_airstrike_officer", count: 1, researchTargetLevel: 6 },
      { unitId: "airborne_infantry", count: 20 },
      { unitId: "air_superiority_fighter", count: 18 },
      { unitId: "elite_frigate", count: 9 },
      { unitId: "elite_drone_mothership", count: 10 },
    ],
  });

  assert.deepEqual(
    result.tranches.map(tranche => ({
      unitId: tranche.unitId,
      mobilizeLevel: tranche.mobilizeLevel,
      count: tranche.count,
    })),
    [
      { unitId: "naval_veteran", mobilizeLevel: 1, count: 1 },
      { unitId: "fixed_wing_veteran", mobilizeLevel: 1, count: 1 },
      { unitId: "epic_airstrike_officer", mobilizeLevel: 1, count: 1 },
      { unitId: "airborne_infantry", mobilizeLevel: 1, count: 20 },
      { unitId: "air_superiority_fighter", mobilizeLevel: 1, count: 18 },
      { unitId: "elite_frigate", mobilizeLevel: 1, count: 5 },
      { unitId: "elite_frigate", mobilizeLevel: 2, count: 4 },
      { unitId: "elite_drone_mothership", mobilizeLevel: 1, count: 5 },
      { unitId: "elite_drone_mothership", mobilizeLevel: 2, count: 5 },
    ]
  );
});

test("mobilization planner can force a unit to mobilise at a higher minimum level", () => {
  const result = planMobilizationBuild({
    catalog: loadMergedUnitCatalog(),
    buildings: loadBuildingsFile(),
    scenario: loadScenarioFile("elite/ww3"),
    demands: [
      { unitId: "epic_airstrike_officer", count: 1, researchTargetLevel: 6, minMobilizeLevel: 6 },
    ],
  });

  assert.deepEqual(
    result.tranches.map(tranche => ({
      unitId: tranche.unitId,
      mobilizeLevel: tranche.mobilizeLevel,
      count: tranche.count,
    })),
    [
      { unitId: "epic_airstrike_officer", mobilizeLevel: 6, count: 1 },
    ]
  );
});

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

test("mobilization planner fits the elite ww3 package before truce end and derives city requirements", () => {
  const scenario = loadScenarioFile("elite/ww3");
  const result = planMobilizationBuild({
    catalog: loadMergedUnitCatalog(),
    buildings: loadBuildingsFile(),
    scenario,
    demands: [
      { unitId: "naval_veteran", count: 1 },
      { unitId: "fixed_wing_veteran", count: 1, researchTargetLevel: 6 },
      { unitId: "epic_airstrike_officer", count: 1, researchTargetLevel: 6 },
      { unitId: "airborne_infantry", count: 20 },
      { unitId: "air_superiority_fighter", count: 18 },
      { unitId: "elite_frigate", count: 9 },
      { unitId: "elite_drone_mothership", count: 10 },
    ],
  });

  const truceDeadlineAbsoluteHour =
    toAbsoluteHour(scenario.start.day, scenario.start.hour) + ((scenario.truce_length_days ?? 0) * 24);
  assert.ok(result.segments.every(segment => segment.endAbsoluteHourExclusive <= truceDeadlineAbsoluteHour));

  const cityProfilesByQueueType = new Map(result.cityProfiles.map(profile => [profile.queueType, profile]));
  assert.deepEqual(cityProfilesByQueueType.get("air"), {
    queueType: "air",
    cityCount: 2,
    requiredBaseLevel: 2,
    requiredArmyBaseLevel: 1,
    requiredRecruitingOfficeLevel: 1,
    perCityQueueHours: [414, 410],
  });
  assert.deepEqual(cityProfilesByQueueType.get("naval"), {
    queueType: "naval",
    cityCount: 1,
    requiredBaseLevel: 4,
    requiredArmyBaseLevel: 0,
    requiredRecruitingOfficeLevel: 1,
    perCityQueueHours: [542],
  });

  for (const segment of result.segments) {
    assert.ok(segment.durationHours > 0);
    assert.ok(segment.moralePct >= 0 && segment.moralePct <= 100);
    assert.equal(segment.recruitingOfficeLevel, 1);
  }

  const earliestMobilizationStartByUnitLevel = new Map<string, number>();
  for (const segment of result.segments) {
    const key = `${segment.unitId}:${segment.mobilizeLevel}`;
    earliestMobilizationStartByUnitLevel.set(
      key,
      Math.min(
        earliestMobilizationStartByUnitLevel.get(key) ?? Number.POSITIVE_INFINITY,
        segment.startAbsoluteHour
      )
    );
  }

  for (const researchSegment of result.researchPlan.segments) {
    const deadline = earliestMobilizationStartByUnitLevel.get(`${researchSegment.unitId}:${researchSegment.level}`);
    if (deadline !== undefined) {
      assert.ok(
        researchSegment.endAbsoluteHourExclusive <= deadline,
        `${researchSegment.unitId} level ${researchSegment.level} research completes after mobilisation starts`
      );
    }
  }
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
