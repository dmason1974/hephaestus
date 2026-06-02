import path from "node:path";

import type { StartingPopulation } from "../../core/constants.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import {
  scheduleBuildSegments,
  type BuildAction,
  type TimelineCityState,
} from "../../engine/orchestration/build-order-timeline.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import type { Country } from "../../schemas/country-schema.js";
import {
  buildHomelandCityBuildOrderFromBaseline,
  challengeHomelandEcoBaseline,
} from "./default-eco-baseline.js";

const scenarioId = "elite/ww3";
const scenario = loadScenarioFile(scenarioId);
const buildingsFile = loadBuildingsFile(path.resolve("data/buildings.yml"));
const turkey = loadScenarioCountry(scenarioId, "turkey");
const iraq = loadScenarioCountry(scenarioId, "iraq");
const greece = loadScenarioCountry(scenarioId, "greece");

const greeceOccupationStartAbsoluteHour = ((3 - 1) * 24) + 0;
const greeceOccupationStartHour = greeceOccupationStartAbsoluteHour - scenarioStartAbsoluteHour(scenario);

function mapDayForAbsoluteHour(absoluteHour: number) {
  return Math.floor(absoluteHour / 24) + 1;
}

function hourOfDayForAbsoluteHour(absoluteHour: number) {
  return (absoluteHour % 24) + 1;
}

function toCityStates(country: Country) {
  return country.cities.map(city => ({
    cityId: `${country.country.id}:${city.id}`,
    countryId: country.country.id,
    capital: city.capital,
    resource: city.resource,
    startPop: city.population as StartingPopulation,
    cityStatus: "homeland" as const,
    buildings: {
      air_base: city.starting.air_base,
      annex_city: 0,
      arms_industry: 0,
      combat_outpost: 0,
      local_industry: 0,
      naval_base: city.starting.naval_base,
      recruiting_office: 0,
      relocate_headquarters: 0,
      underground_bunkers: city.starting.underground_bunkers,
    },
  }));
}

function toTimelineCityStates(cities: ReturnType<typeof toCityStates>): TimelineCityState[] {
  return cities.map(city => ({
    cityId: city.cityId,
    countryId: city.countryId,
    capital: city.capital,
    cityStatus: city.cityStatus,
    moraleParams: city.moraleParams,
    buildings: city.buildings,
  }));
}

function occupiedGreekCityState(cityId: string) {
  const city = greece.cities.find(entry => entry.id === cityId);
  if (!city) {
    throw new Error(`unknown Greece city "${cityId}"`);
  }

  return {
    cityId: `greece:${city.id}`,
    countryId: "greece",
    capital: city.capital,
    resource: city.resource,
    startPop: city.population as StartingPopulation,
    cityStatus: "occupied" as const,
    buildings: {
      air_base: city.starting.air_base,
      annex_city: 0,
      arms_industry: 0,
      combat_outpost: 0,
      local_industry: 0,
      naval_base: city.starting.naval_base,
      recruiting_office: 0,
      relocate_headquarters: 0,
      underground_bunkers: city.starting.underground_bunkers,
    },
  };
}

function greekCityBuildOrder(cityId: string): BuildAction[] {
  return [
    { cityId, buildingId: "recruiting_office", targetLevel: 1, startHour: greeceOccupationStartHour },
    { cityId, buildingId: "annex_city", targetLevel: 1, startHour: greeceOccupationStartHour },
    { cityId, buildingId: "arms_industry", targetLevel: 1, startHour: greeceOccupationStartHour },
    { cityId, buildingId: "underground_bunkers", targetLevel: 3, startHour: greeceOccupationStartHour },
    { cityId, buildingId: "arms_industry", targetLevel: 5, startHour: greeceOccupationStartHour },
  ];
}

function printCityBuildTables(args: {
  label: string;
  cities: Array<{
    cityId: string;
    resource: string;
    cityStatus: "homeland" | "occupied";
    capital?: boolean;
  }>;
  buildOrder: BuildAction[];
  timelineCities: TimelineCityState[];
}) {
  const segmentsByCity = scheduleBuildSegments({
    cities: args.timelineCities,
    buildOrder: args.buildOrder,
    buildings: buildingsFile,
    scenario,
  });

  console.log(args.label);

  for (const city of args.cities) {
    const citySegments = segmentsByCity.get(city.cityId);
    const rows = Object.values(citySegments ?? {})
      .flatMap(segments => segments)
      .sort((a, b) => a.startMinute - b.startMinute || a.buildingId.localeCompare(b.buildingId))
      .map(segment => ({
        buildingId: segment.buildingId,
        fromLevel: segment.fromLevel,
        toLevel: segment.toLevel,
        startDay: mapDayForAbsoluteHour(segment.startMinute / 60),
        startHour: Number(hourOfDayForAbsoluteHour(segment.startMinute / 60).toFixed(2)),
        endDay: mapDayForAbsoluteHour(segment.endMinute / 60),
        endHour: Number(hourOfDayForAbsoluteHour(segment.endMinute / 60).toFixed(2)),
        durationHours: Number(((segment.endMinute - segment.startMinute) / 60).toFixed(2)),
      }));

    console.log(
      `${city.cityId} (${city.resource}, ${city.cityStatus}${city.capital ? ", capital" : ""})`
    );
    console.table(rows);
  }
}

const turkeyCities = toCityStates(turkey);
const iraqCities = toCityStates(iraq);
const greekElectronicsCity = occupiedGreekCityState("thessaloniki");
const greekSuppliesCity = occupiedGreekCityState("heraklion");

console.log("Elite WW3 city build orders");
console.log(`Scenario: ${scenario.id} (${scenario.speed})`);
console.log(
  `Scenario start: day ${scenario.start.day}, hour ${scenario.start.hour}, t0=${scenarioStartAbsoluteHour(
    scenario
  )}`
);
console.log("Assumptions:");
console.log(`- Turkey and Iraq homeland cities use the ${challengeHomelandEcoBaseline.name} eco baseline`);
console.log("- Greece is owned from map day 3");
console.log("- Greece city plans are only for thessaloniki and heraklion");
console.log("- Greece city queues start on map day 3, hour 1");

printCityBuildTables({
  label: "Turkey",
  cities: turkeyCities,
  buildOrder: buildHomelandCityBuildOrderFromBaseline(turkey, challengeHomelandEcoBaseline),
  timelineCities: toTimelineCityStates(turkeyCities),
});

printCityBuildTables({
  label: "Iraq",
  cities: iraqCities,
  buildOrder: buildHomelandCityBuildOrderFromBaseline(iraq, challengeHomelandEcoBaseline),
  timelineCities: toTimelineCityStates(iraqCities),
});

printCityBuildTables({
  label: "Greece",
  cities: [greekElectronicsCity, greekSuppliesCity],
  buildOrder: [
    ...greekCityBuildOrder(greekElectronicsCity.cityId),
    ...greekCityBuildOrder(greekSuppliesCity.cityId),
  ],
  timelineCities: toTimelineCityStates([greekElectronicsCity, greekSuppliesCity]),
});
