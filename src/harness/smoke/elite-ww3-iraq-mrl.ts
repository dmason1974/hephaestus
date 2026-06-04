import path from "node:path";

import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadUnitCatalog } from "../../scenarios/io/load-unit-catalog.js";
import { planMobilizationBuild } from "../../engine/simulation/unit-mobilization-plan.js";
import { buildFixedResearchPlan } from "./fixed-research-plan.js";

function mapDayForAbsoluteHour(absoluteHour: number) {
  return Math.floor(absoluteHour / 24) + 1;
}

function hourOfDayForAbsoluteHour(absoluteHour: number) {
  return (absoluteHour % 24) + 1;
}

const scenarioId = "elite/ww3";
const scenario = loadScenarioFile(scenarioId);
const iraq = loadScenarioCountry(scenarioId, "iraq");
const buildings = loadBuildingsFile();
const supportCatalog = loadUnitCatalog(path.resolve("data/units/support_units.yml"));
const infantryCatalog = loadUnitCatalog(path.resolve("data/units/infantry_units.yml"));
const officerCatalog = loadUnitCatalog(path.resolve("data/units/officer_units.yml"));

const mergedCatalog = {
  ...supportCatalog,
  units: {
    ...supportCatalog.units,
    ...infantryCatalog.units,
    ...officerCatalog.units,
  },
};

const demands = [
  { unitId: "multiple_rocket_launcher", count: 42, researchTargetLevel: 5, queueGroup: "mrl", forcedCityCount: 3 },
  { unitId: "mobile_anti_air_vehicle", count: 45, researchTargetLevel: 6, queueGroup: "maav", forcedCityCount: 2 },
  { unitId: "special_forces", count: 20, researchTargetLevel: 5, queueGroup: "sf", forcedCityCount: 1 },
  { unitId: "uncommon_infantry_officer", count: 1, researchTargetLevel: 7, queueGroup: "maav", forcedCityCount: 2 },
];

function effectiveMobilizeLevelForSegment(
  researchSegments: typeof researchPlan.segments,
  unitId: string,
  plannedLevel: number,
  startAbsoluteHour: number
) {
  const completedLevels = researchSegments
    .filter(segment => segment.unitId === unitId && segment.endAbsoluteHourExclusive <= startAbsoluteHour)
    .map(segment => segment.level);

  return Math.max(plannedLevel, completedLevels.length === 0 ? plannedLevel : Math.max(...completedLevels));
}

const result = planMobilizationBuild({
  catalog: mergedCatalog,
  buildings,
  scenario,
  demands,
});

const firstMobilizationStartByUnit = Object.fromEntries(
  Array.from(new Set(result.segments.map(segment => segment.unitId))).map(unitId => [
    unitId,
    Math.min(
      ...result.segments
        .filter(segment => segment.unitId === unitId)
        .map(segment => segment.startAbsoluteHour)
    ),
  ])
) as Record<string, number>;

const researchPlan = buildFixedResearchPlan({
  catalog: mergedCatalog,
  scenario,
  doctrine: iraq.country.doctrine,
  lanes: [
    [
      { unitId: "uncommon_infantry_officer", targetLevel: 1 },
      { unitId: "mobile_anti_air_vehicle", targetLevel: 1 },
      { unitId: "uncommon_infantry_officer", targetLevel: 2 },
      { unitId: "uncommon_infantry_officer", targetLevel: 3 },
      { unitId: "uncommon_infantry_officer", targetLevel: 4 },
      { unitId: "uncommon_infantry_officer", targetLevel: 5 },
      { unitId: "uncommon_infantry_officer", targetLevel: 6 },
      { unitId: "uncommon_infantry_officer", targetLevel: 7 },
      { unitId: "mobile_anti_air_vehicle", targetLevel: 2 },
      { unitId: "mobile_anti_air_vehicle", targetLevel: 3 },
      { unitId: "mobile_anti_air_vehicle", targetLevel: 4 },
      { unitId: "mobile_anti_air_vehicle", targetLevel: 5 },
      { unitId: "mobile_anti_air_vehicle", targetLevel: 6 },
    ],
    [
      { unitId: "special_forces", targetLevel: 1 },
      { unitId: "multiple_rocket_launcher", targetLevel: 1 },
      { unitId: "special_forces", targetLevel: 2 },
      { unitId: "multiple_rocket_launcher", targetLevel: 2 },
      { unitId: "special_forces", targetLevel: 3 },
      { unitId: "multiple_rocket_launcher", targetLevel: 3 },
      { unitId: "special_forces", targetLevel: 4 },
      { unitId: "multiple_rocket_launcher", targetLevel: 4 },
      { unitId: "special_forces", targetLevel: 5 },
      { unitId: "multiple_rocket_launcher", targetLevel: 5 },
    ],
  ],
  latestEndByAction: {
    "mobile_anti_air_vehicle@1": firstMobilizationStartByUnit.mobile_anti_air_vehicle,
    "special_forces@1": firstMobilizationStartByUnit.special_forces,
    "multiple_rocket_launcher@1": firstMobilizationStartByUnit.multiple_rocket_launcher,
  },
});

const iraqLandCandidates = iraq.cities
  .filter(city => city.resource === "electronics" || city.resource === "supplies" || city.resource === "components")
  .sort((a, b) => {
    const priority = { electronics: 0, supplies: 1, components: 2 } as const;
    return priority[a.resource as keyof typeof priority] - priority[b.resource as keyof typeof priority];
  })
  .map(city => ({
    cityId: city.id,
    resource: city.resource,
    startingAirBase: city.starting.air_base,
    startingNavalBase: city.starting.naval_base,
  }));

const iraqAirCandidates = iraq.cities
  .filter(city => city.starting.air_base > 0 || city.capital || city.resource === "supplies")
  .sort((a, b) => {
    const score = (city: typeof iraq.cities[number]) => {
      if (city.starting.air_base > 0 || city.capital) return 0;
      if (city.resource === "supplies") return 1;
      return 2;
    };
    return score(a) - score(b);
  })
  .map(city => ({
    cityId: city.id,
    resource: city.resource,
    capital: city.capital,
    startingAirBase: city.starting.air_base,
    note: city.id === "karbala"
      ? "preferred second Iraq airfield in supplies city"
      : city.id === "baghdad"
        ? "existing Iraq air-capable capital"
        : "",
  }));

console.log("Elite WW3 Iraq land-package smoke");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(`Start: day ${scenario.start.day}, hour ${scenario.start.hour}`);
console.log(`Truce length: ${scenario.truce_length_days ?? 0} days`);
console.log("Assumption: Iraq mobilises 42 multiple_rocket_launcher researched to 5, 45 mobile_anti_air_vehicle researched to 6, 20 special_forces researched to 5, and 1 uncommon_infantry_officer researched to 7");
console.log("Queue assumption: 3 dedicated MRL cities, 2 dedicated MAAV cities, and 1 dedicated SF city");
console.log("Costing assumption: later units step up to the highest researched level completed by their mobilisation start");
console.log("Research lanes: slot 1 = officer 1, MAAV 1, then full officer line before MAAV 2-6; slot 2 = SF1/MRL1/SF2/MRL2/.../SF5/MRL5, with level 1 anchored before queue starts");
console.log("Suggested Iraq land-build city priority:");
console.table(iraqLandCandidates);
console.log("Suggested Iraq air-capable city priority for special forces:");
console.table(iraqAirCandidates);

console.log("Derived city footprint");
console.table(result.cityProfiles.map(profile => ({
  queueType: profile.queueType,
  queueKey: profile.queueKey,
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
  queueKey: tranche.queueKey,
  requiredBaseLevel: tranche.requiredBaseLevel,
  requiredArmyBaseLevel: tranche.requiredArmyBaseLevel,
  requiredRecruitingOfficeLevel: tranche.requiredRecruitingOfficeLevel,
  baseMobilizationHours: tranche.baseMobilizationHours,
})));

for (const slot of [1, 2] as const) {
  console.log(`Research slot ${slot}`);
  console.table(
    researchPlan.segments
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
    console.log(`${profile.queueKey} queue city ${cityIndex}`);
    console.table(
      result.segments
        .filter(
          segment =>
            segment.queueKey === profile.queueKey &&
            segment.cityIndex === cityIndex
        )
        .map(segment => ({
          unitId: segment.unitId,
          mobilizeLevel: segment.mobilizeLevel,
          effectiveLevel: effectiveMobilizeLevelForSegment(
            researchPlan.segments,
            segment.unitId,
            segment.mobilizeLevel,
            segment.startAbsoluteHour
          ),
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
