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

const scenarioId = "elite_ww3_2026";
const scenario = loadScenarioFile(scenarioId);
const turkey = loadScenarioCountry(scenarioId, "turkey");
const buildings = loadBuildingsFile();
const navalCatalog = loadUnitCatalog(path.resolve("data/units/naval_units.yml"));
const fighterCatalog = loadUnitCatalog(path.resolve("data/units/fighter_units.yml"));
const heaviesCatalog = loadUnitCatalog(path.resolve("data/units/heavies_units.yml"));
const infantryCatalog = loadUnitCatalog(path.resolve("data/units/infantry_units.yml"));
const officerCatalog = loadUnitCatalog(path.resolve("data/units/officer_units.yml"));
const seasonalCatalog = loadUnitCatalog(path.resolve("data/units/seasonal_units.yml"));

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
  { unitId: "fixed_wing_veteran", count: 1, researchTargetLevel: 6, queueGroup: "istanbul_air", forcedCityCount: 1 },
  { unitId: "epic_airstrike_officer", count: 1, researchTargetLevel: 6, queueGroup: "istanbul_air", forcedCityCount: 1 },
  { unitId: "awacs", count: 2, researchTargetLevel: 6, queueGroup: "istanbul_air", forcedCityCount: 1 },
  { unitId: "awacs", count: 2, researchTargetLevel: 6, queueGroup: "thess_air", forcedCityCount: 1 },
  { unitId: "air_superiority_fighter", count: 9, queueGroup: "istanbul_air", forcedCityCount: 1 },
  { unitId: "air_superiority_fighter", count: 9, queueGroup: "thess_air", forcedCityCount: 1 },
  { unitId: "airborne_infantry", count: 20, queueGroup: "ankara_airmobile", forcedCityCount: 1 },
  { unitId: "naval_veteran", count: 1, queueGroup: "antalya_eff", forcedCityCount: 1 },
  { unitId: "elite_frigate", count: 9, queueGroup: "antalya_eff", forcedCityCount: 1 },
  { unitId: "elite_drone_mothership", count: 10, queueGroup: "izmir_dms", forcedCityCount: 1 },
];

const queueCityNames: Record<string, string[]> = {
  "air:istanbul_air": ["istanbul"],
  "air:thess_air": ["thessaloniki"],
  "air:ankara_airmobile": ["ankara"],
  "naval:antalya_eff": ["antalya"],
  "naval:izmir_dms": ["izmir"],
};

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
  lanes: [
    [
      { unitId: "fixed_wing_veteran", targetLevel: 1 },
      { unitId: "fixed_wing_veteran", targetLevel: 2 },
      { unitId: "fixed_wing_veteran", targetLevel: 3 },
      { unitId: "fixed_wing_veteran", targetLevel: 4 },
      { unitId: "fixed_wing_veteran", targetLevel: 5 },
      { unitId: "fixed_wing_veteran", targetLevel: 6 },
      { unitId: "frigate", targetLevel: 1 },
      { unitId: "frigate", targetLevel: 2 },
      { unitId: "frigate", targetLevel: 3 },
      { unitId: "frigate", targetLevel: 4 },
      { unitId: "airborne_infantry", targetLevel: 1 },
      { unitId: "air_superiority_fighter", targetLevel: 1 },
      { unitId: "elite_drone_mothership", targetLevel: 1 },
      { unitId: "elite_drone_mothership", targetLevel: 2 },
      { unitId: "air_superiority_fighter", targetLevel: 2 },
      { unitId: "air_superiority_fighter", targetLevel: 3 },
      { unitId: "air_superiority_fighter", targetLevel: 4 },
      { unitId: "air_superiority_fighter", targetLevel: 5 },
      { unitId: "air_superiority_fighter", targetLevel: 6 },
      { unitId: "air_superiority_fighter", targetLevel: 7 },
    ],
    [
      { unitId: "epic_airstrike_officer", targetLevel: 1 },
      { unitId: "epic_airstrike_officer", targetLevel: 2 },
      { unitId: "epic_airstrike_officer", targetLevel: 3 },
      { unitId: "epic_airstrike_officer", targetLevel: 4 },
      { unitId: "epic_airstrike_officer", targetLevel: 5 },
      { unitId: "epic_airstrike_officer", targetLevel: 6 },
      { unitId: "naval_veteran", targetLevel: 1 },
      { unitId: "naval_veteran", targetLevel: 2 },
      { unitId: "naval_veteran", targetLevel: 3 },
      { unitId: "naval_veteran", targetLevel: 4 },
      { unitId: "naval_veteran", targetLevel: 5 },
      { unitId: "naval_veteran", targetLevel: 6 },
      { unitId: "naval_veteran", targetLevel: 7 },
      { unitId: "awacs", targetLevel: 1 },
      { unitId: "awacs", targetLevel: 2 },
      { unitId: "awacs", targetLevel: 3 },
      { unitId: "awacs", targetLevel: 4 },
      { unitId: "awacs", targetLevel: 5 },
      { unitId: "awacs", targetLevel: 6 },
    ],
  ],
  latestEndByAction: {
    "airborne_infantry@1": firstMobilizationStartByUnit.airborne_infantry,
    "air_superiority_fighter@1": firstMobilizationStartByUnit.air_superiority_fighter,
    "awacs@1": firstMobilizationStartByUnit.awacs,
  },
});

function effectiveMobilizeLevelForSegment(
  unitId: string,
  plannedLevel: number,
  startAbsoluteHour: number
) {
  const completedLevels = researchPlan.segments
    .filter(segment => segment.unitId === unitId && segment.endAbsoluteHourExclusive <= startAbsoluteHour)
    .map(segment => segment.level);

  return Math.max(plannedLevel, completedLevels.length === 0 ? plannedLevel : Math.max(...completedLevels));
}

const turkeyAirCandidates = turkey.cities
  .filter(city => city.starting.air_base > 0 || city.resource === "electronics" || city.resource === "supplies")
  .sort((a, b) => {
    const score = (city: typeof turkey.cities[number]) => {
      if (city.resource === "electronics") return 0;
      if (city.starting.air_base > 0 || city.capital) return 1;
      if (city.resource === "supplies") return 2;
      return 3;
    };
    return score(a) - score(b);
  })
  .map(city => ({
    cityId: city.id,
    resource: city.resource,
    capital: city.capital,
    startingAirBase: city.starting.air_base,
  }));

const turkeyNavalCandidates = turkey.cities
  .filter(city => city.starting.naval_base > 0 || city.resource === "electronics" || city.resource === "supplies")
  .sort((a, b) => {
    const score = (city: typeof turkey.cities[number]) => {
      if (city.resource === "electronics") return 0;
      if (city.starting.naval_base > 0) return 1;
      if (city.resource === "supplies") return 2;
      return 3;
    };
    return score(a) - score(b);
  })
  .map(city => ({
    cityId: city.id,
    resource: city.resource,
    startingNavalBase: city.starting.naval_base,
  }));

console.log("Elite WW3 Turkey mobilisation smoke");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(`Start: day ${scenario.start.day}, hour ${scenario.start.hour}`);
console.log(`Truce length: ${scenario.truce_length_days ?? 0} days`);
console.log("Assumption: Turkey uses an explicit named mobilisation layout rather than generic city assignment");
console.log("- air: istanbul -> ASF/AWACS/officers, thessaloniki -> ASF/AWACS, ankara -> airborne");
console.log("- naval: antalya -> naval_veteran + elite_frigate, izmir -> elite_drone_mothership");
console.log("- recruiting_office 3 is intended in all mobilisation cities");
console.log("Deployable gear assumption: 40 deployable_gear are handled outside this mobilisation plan and assumed completed by map day 7");
console.log("Reference Turkey air-capable city priority:");
console.table(turkeyAirCandidates);
console.log("Reference Turkey naval-capable city priority:");
console.table(turkeyNavalCandidates);

console.log("Derived city footprint");
console.table(result.cityProfiles.map(profile => ({
  queueType: profile.queueType,
  queueKey: profile.queueKey,
  assignedCities: (queueCityNames[profile.queueKey] ?? []).join(", "),
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
    const cityName = queueCityNames[profile.queueKey]?.[cityIndex - 1] ?? `city ${cityIndex}`;
    console.log(`${profile.queueKey} queue (${cityName})`);
    console.table(
      result.segments
        .filter(segment => segment.queueKey === profile.queueKey && segment.cityIndex === cityIndex)
        .map(segment => ({
          city: cityName,
          unitId: segment.unitId,
          mobilizeLevel: segment.mobilizeLevel,
          effectiveLevel: effectiveMobilizeLevelForSegment(
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
