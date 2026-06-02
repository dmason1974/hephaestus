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
