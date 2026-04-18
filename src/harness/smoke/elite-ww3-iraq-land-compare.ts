import path from "node:path";

import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
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

const scenarioId = "elite_ww3_2026";
const scenario = loadScenarioFile(scenarioId);
const iraq = loadScenarioCountry(scenarioId, "iraq");
const buildings = loadBuildingsFile();
const supportCatalog = loadUnitCatalog(path.resolve("data/units/support_units.yml"));

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

const combinedDemands = [
  { unitId: "multiple_rocket_launcher", count: 28, researchTargetLevel: 1 },
  { unitId: "mobile_anti_air_vehicle", count: 45, researchTargetLevel: 6 },
];

const mrlOnlyDemands = [
  { unitId: "multiple_rocket_launcher", count: 28, researchTargetLevel: 1 },
];

const maavOnlyDemands = [
  { unitId: "mobile_anti_air_vehicle", count: 45, researchTargetLevel: 6 },
];

const combinedResult = planMobilizationBuild({
  catalog: supportCatalog,
  buildings,
  scenario,
  demands: combinedDemands,
});

const mrlOnlyResult = planMobilizationBuild({
  catalog: supportCatalog,
  buildings,
  scenario,
  demands: mrlOnlyDemands,
});

const maavOnlyResult = planMobilizationBuild({
  catalog: supportCatalog,
  buildings,
  scenario,
  demands: maavOnlyDemands,
});

const combinedLand = combinedResult.cityProfiles.find(profile => profile.queueType === "land");
const mrlLand = mrlOnlyResult.cityProfiles.find(profile => profile.queueType === "land");
const maavLand = maavOnlyResult.cityProfiles.find(profile => profile.queueType === "land");

function totalQueueHours(hours: number[] | undefined) {
  return (hours ?? []).reduce((sum, value) => sum + value, 0);
}

function earliestStart(result: typeof combinedResult) {
  const first = result.segments[0];
  if (!first) return null;
  return {
    mapDay: mapDayForAbsoluteHour(first.startAbsoluteHour),
    hourOfDay: hourOfDayForAbsoluteHour(first.startAbsoluteHour),
  };
}

console.log("Elite WW3 Iraq land-package comparison");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log("Candidate city priority:");
console.table(iraqLandCandidates);

console.log("Combined approach: 28 MRL + 45 MAAV in one shared land pool");
console.table([{
  cityCount: combinedLand?.cityCount ?? 0,
  requiredArmyBaseLevel: combinedLand?.requiredArmyBaseLevel ?? 0,
  requiredRecruitingOfficeLevel: combinedLand?.requiredRecruitingOfficeLevel ?? 0,
  perCityQueueHours: combinedLand?.perCityQueueHours.join(", ") ?? "",
  totalQueueHours: totalQueueHours(combinedLand?.perCityQueueHours),
  earliestMobilizationStartDay: earliestStart(combinedResult)?.mapDay ?? "",
  earliestMobilizationStartHour: earliestStart(combinedResult)?.hourOfDay ?? "",
}]);

console.log("Split approach: 2-city MRL pool + 3-city MAAV pool");
console.table([
  {
    package: "MRL only",
    cityCount: mrlLand?.cityCount ?? 0,
    requiredArmyBaseLevel: mrlLand?.requiredArmyBaseLevel ?? 0,
    requiredRecruitingOfficeLevel: mrlLand?.requiredRecruitingOfficeLevel ?? 0,
    perCityQueueHours: mrlLand?.perCityQueueHours.join(", ") ?? "",
    totalQueueHours: totalQueueHours(mrlLand?.perCityQueueHours),
    earliestMobilizationStartDay: earliestStart(mrlOnlyResult)?.mapDay ?? "",
    earliestMobilizationStartHour: earliestStart(mrlOnlyResult)?.hourOfDay ?? "",
  },
  {
    package: "MAAV only",
    cityCount: maavLand?.cityCount ?? 0,
    requiredArmyBaseLevel: maavLand?.requiredArmyBaseLevel ?? 0,
    requiredRecruitingOfficeLevel: maavLand?.requiredRecruitingOfficeLevel ?? 0,
    perCityQueueHours: maavLand?.perCityQueueHours.join(", ") ?? "",
    totalQueueHours: totalQueueHours(maavLand?.perCityQueueHours),
    earliestMobilizationStartDay: earliestStart(maavOnlyResult)?.mapDay ?? "",
    earliestMobilizationStartHour: earliestStart(maavOnlyResult)?.hourOfDay ?? "",
  },
]);

console.log("Suggested practical split:");
console.log("- MRL cities: mosul + karbala");
console.log("- MAAV cities: mosul + karbala + qa'im");
