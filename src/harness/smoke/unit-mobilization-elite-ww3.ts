import path from "node:path";

import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadUnitCatalog } from "../../scenarios/io/load-unit-catalog.js";
import { planMobilizationBuild } from "../../engine/simulation/unit-mobilization-plan.js";

function mapDayForAbsoluteHour(absoluteHour: number) {
  return Math.floor(absoluteHour / 24) + 1;
}

function hourOfDayForAbsoluteHour(absoluteHour: number) {
  return (absoluteHour % 24) + 1;
}

const scenario = loadScenarioFile("elite_ww3_2026");
const buildings = loadBuildingsFile();
const navalCatalog = loadUnitCatalog(path.resolve("data/units/naval_units.yaml"));
const fighterCatalog = loadUnitCatalog(path.resolve("data/units/fighter_units.yaml"));
const heaviesCatalog = loadUnitCatalog(path.resolve("data/units/heavies_units.yaml"));
const infantryCatalog = loadUnitCatalog(path.resolve("data/units/infantry_units.yaml"));
const officerCatalog = loadUnitCatalog(path.resolve("data/units/officer_units.yaml"));
const seasonalCatalog = loadUnitCatalog(path.resolve("data/units/seasonal_units.yaml"));

const mergedCatalog = {
  ...navalCatalog,
  units: {
    ...navalCatalog.units,
    ...fighterCatalog.units,
    ...heaviesCatalog.units,
    ...infantryCatalog.units,
    ...officerCatalog.units,
    ...seasonalCatalog.units,
  },
};

const demands = [
  { unitId: "naval_veteran", count: 1 },
  { unitId: "fixed_wing_veteran", count: 1, researchTargetLevel: 6 },
  { unitId: "epic_airstrike_officer", count: 1, researchTargetLevel: 6 },
  { unitId: "awacs", count: 4, researchTargetLevel: 6 },
  { unitId: "airborne_infantry", count: 20 },
  { unitId: "air_superiority_fighter", count: 18 },
  { unitId: "elite_frigate", count: 9 },
  { unitId: "elite_drone_mothership", count: 10 },
];

const result = planMobilizationBuild({
  catalog: mergedCatalog,
  buildings,
  scenario,
  demands,
});

console.log("Elite WW3 mobilisation smoke");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(`Start: day ${scenario.start.day}, hour ${scenario.start.hour}`);
console.log(`Truce length: ${scenario.truce_length_days ?? 0} days`);
console.log("Demands:", demands);

console.log("Derived city footprint");
  console.table(result.cityProfiles.map(profile => ({
  queueType: profile.queueType,
  cityCount: profile.cityCount,
  requiredBaseLevel: profile.requiredBaseLevel,
  requiredArmyBaseLevel: profile.requiredArmyBaseLevel,
  requiredRecruitingOfficeLevel: profile.requiredRecruitingOfficeLevel,
  perCityQueueHours: profile.perCityQueueHours.join(", "),
})));

console.log("Mobilisation tranches");
console.table(result.tranches.map(tranche => ({
  unitId: tranche.unitId,
  mobilizeLevel: tranche.mobilizeLevel,
  count: tranche.count,
  queueType: tranche.queueType,
  requiredBaseLevel: tranche.requiredBaseLevel,
  requiredRecruitingOfficeLevel: tranche.requiredRecruitingOfficeLevel,
  baseMobilizationHours: tranche.baseMobilizationHours,
})));

for (const slot of [1, 2] as const) {
  console.log(`Research slot ${slot}`);
  console.table(
    result.researchPlan.segments
      .filter(segment => segment.slot === slot)
      .map(segment => ({
        unitId: segment.unitId,
        level: segment.level,
        startDay: mapDayForAbsoluteHour(segment.startAbsoluteHour),
        startHour: hourOfDayForAbsoluteHour(segment.startAbsoluteHour),
        endDay: mapDayForAbsoluteHour(segment.endAbsoluteHourExclusive),
        endHour: hourOfDayForAbsoluteHour(segment.endAbsoluteHourExclusive),
        durationHours: segment.durationHours,
      }))
  );
}

for (const profile of result.cityProfiles) {
  for (let cityIndex = 1; cityIndex <= profile.cityCount; cityIndex++) {
    console.log(`${profile.queueType} queue city ${cityIndex}`);
    console.table(
      result.segments
        .filter(segment => segment.queueType === profile.queueType && segment.cityIndex === cityIndex)
        .map(segment => ({
          unitId: segment.unitId,
          mobilizeLevel: segment.mobilizeLevel,
          startDay: mapDayForAbsoluteHour(segment.startAbsoluteHour),
          startHour: hourOfDayForAbsoluteHour(segment.startAbsoluteHour),
          endDay: mapDayForAbsoluteHour(segment.endAbsoluteHourExclusive),
          endHour: hourOfDayForAbsoluteHour(segment.endAbsoluteHourExclusive),
          durationHours: segment.durationHours,
          moralePct: segment.moralePct,
          recruitingOfficeLevel: segment.recruitingOfficeLevel,
        }))
    );
  }
}
