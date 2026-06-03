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

const scenario = loadScenarioFile("elite/ww3");
const buildings = loadBuildingsFile();
const supportCatalog = loadUnitCatalog(path.resolve("data/units/support_units.yml"));

const demands = [
  { unitId: "multiple_rocket_launcher", count: 28, researchTargetLevel: 1 },
];

const result = planMobilizationBuild({
  catalog: supportCatalog,
  buildings,
  scenario,
  demands,
});

console.log("Elite WW3 Greece MRL smoke");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(`Start: day ${scenario.start.day}, hour ${scenario.start.hour}`);
console.log(`Truce length: ${scenario.truce_length_days ?? 0} days`);
console.log("Assumption: 28 multiple_rocket_launcher researched to 1 and mobilised at 1");
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
  requiredArmyBaseLevel: tranche.requiredArmyBaseLevel,
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
