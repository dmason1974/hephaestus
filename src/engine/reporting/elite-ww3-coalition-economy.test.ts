import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { buildCountryHourlyResourceBalanceTable } from "./country-resource-balance.js";
import type { Resource } from "../../core/constants.js";

const RESOURCE_KEYS: Resource[] = [
  "supplies",
  "components",
  "fuel",
  "rares",
  "electronics",
  "cash",
  "manpower",
];

function startAbsoluteHour(day: number, hour: number) {
  return ((day - 1) * 24) + hour;
}

function hourlyProductionDeltas(
  table: ReturnType<typeof buildCountryHourlyResourceBalanceTable>,
  absoluteHourOffset: number
) {
  return table.rows.map((row, index) => {
    const previous = index === 0 ? null : table.rows[index - 1]?.balances;
    const deltas = Object.fromEntries(
      RESOURCE_KEYS.map(resource => [
        resource,
        previous ? row.balances[resource] - previous[resource] : row.balances[resource],
      ])
    ) as Record<Resource, number>;

    return {
      absoluteHour: absoluteHourOffset + index,
      deltas,
    };
  });
}

test("elite ww3 coalition baseline economy includes occupied Greece from map day 3 over 28 full days", () => {
  const scenarioId = "elite/ww3";
  const scenario = loadScenarioFile(scenarioId);
  const buildingsFile = loadBuildingsFile(path.resolve("data/buildings.yml"));
  const turkey = loadScenarioCountry(scenarioId, "turkey");
  const iraq = loadScenarioCountry(scenarioId, "iraq");
  const greece = loadScenarioCountry(scenarioId, "greece");

  const hoursToSimulate = 28 * 24;
  const daysToSimulate = Math.ceil(hoursToSimulate / 24);
  const simulationStartAbsoluteHour = startAbsoluteHour(scenario.start.day, scenario.start.hour);
  const greeceOccupationStartAbsoluteHour = startAbsoluteHour(3, 0);

  const occupiedGreeceScenario = {
    ...scenario,
    city_statuses: {
      ...(scenario.city_statuses ?? {}),
      greece: Object.fromEntries(greece.cities.map(city => [city.id, "occupied" as const])),
    },
  };

  const turkeyTable = buildCountryHourlyResourceBalanceTable(
    turkey,
    daysToSimulate,
    scenario.speed,
    {
      buildingsFile,
      scenario,
      startAbsoluteHour: simulationStartAbsoluteHour,
    }
  );
  const iraqTable = buildCountryHourlyResourceBalanceTable(
    iraq,
    daysToSimulate,
    scenario.speed,
    {
      buildingsFile,
      scenario,
      startAbsoluteHour: simulationStartAbsoluteHour,
    }
  );
  const greeceTable = buildCountryHourlyResourceBalanceTable(
    greece,
    daysToSimulate,
    scenario.speed,
    {
      buildingsFile,
      scenario: occupiedGreeceScenario,
      startAbsoluteHour: simulationStartAbsoluteHour,
      provinceDefaults: {
        cityStatus: "occupied",
      },
    }
  );

  const turkeyHourly = hourlyProductionDeltas(turkeyTable, simulationStartAbsoluteHour).slice(0, hoursToSimulate);
  const iraqHourly = hourlyProductionDeltas(iraqTable, simulationStartAbsoluteHour).slice(0, hoursToSimulate);
  const greeceHourly = hourlyProductionDeltas(greeceTable, simulationStartAbsoluteHour).slice(0, hoursToSimulate);

  const daily = Array.from({ length: 28 }, (_, dayIndex) => {
    const row = {
      day: dayIndex + 1,
      supplies: 0,
      components: 0,
      fuel: 0,
      rares: 0,
      electronics: 0,
      cash: 0,
      manpower: 0,
    };

    for (let hourIndex = 0; hourIndex < 24; hourIndex++) {
      const index = (dayIndex * 24) + hourIndex;
      const greeceIncluded = turkeyHourly[index].absoluteHour >= greeceOccupationStartAbsoluteHour;

      for (const resource of RESOURCE_KEYS) {
        row[resource] += turkeyHourly[index].deltas[resource];
        row[resource] += iraqHourly[index].deltas[resource];
        row[resource] += greeceIncluded ? greeceHourly[index].deltas[resource] : 0;
      }
    }

    return row;
  });

  assert.deepEqual(
    {
      startAbsoluteHour: simulationStartAbsoluteHour,
      hoursToSimulate,
      endAbsoluteHour: simulationStartAbsoluteHour + hoursToSimulate,
      endMapDay: Math.floor((simulationStartAbsoluteHour + hoursToSimulate) / 24) + 1,
      endHourOfDay: (simulationStartAbsoluteHour + hoursToSimulate) % 24,
    },
    {
      startAbsoluteHour: 15,
      hoursToSimulate: 672,
      endAbsoluteHour: 687,
      endMapDay: 29,
      endHourOfDay: 15,
    }
  );

  assert.deepEqual(daily, [
    { day: 1, supplies: 8818, components: 4140, fuel: 4409, rares: 2970, electronics: 3227, cash: 33764, manpower: 2583 },
    { day: 2, supplies: 9436, components: 4358, fuel: 4823, rares: 3243, electronics: 3517, cash: 36035, manpower: 2997 },
    { day: 3, supplies: 10071, components: 4605, fuel: 5223, rares: 3437, electronics: 3790, cash: 37995, manpower: 3270 },
    { day: 4, supplies: 10531, components: 4711, fuel: 5476, rares: 3562, electronics: 3964, cash: 39199, manpower: 3375 },
    { day: 5, supplies: 10733, components: 4821, fuel: 5590, rares: 3680, electronics: 4053, cash: 39926, manpower: 3471 },
    { day: 6, supplies: 10830, components: 4856, fuel: 5643, rares: 3765, electronics: 4092, cash: 40419, manpower: 3480 },
    { day: 7, supplies: 10962, components: 4941, fuel: 5709, rares: 3810, electronics: 4149, cash: 40836, manpower: 3543 },
    { day: 8, supplies: 11157, components: 5016, fuel: 5815, rares: 3849, electronics: 4206, cash: 41340, manpower: 3696 },
    { day: 9, supplies: 11340, components: 5094, fuel: 5910, rares: 3899, electronics: 4260, cash: 41962, manpower: 3711 },
    { day: 10, supplies: 11525, components: 5187, fuel: 6010, rares: 3953, electronics: 4365, cash: 42648, manpower: 3735 },
    { day: 11, supplies: 11640, components: 5232, fuel: 6072, rares: 4021, electronics: 4392, cash: 42894, manpower: 3744 },
    { day: 12, supplies: 11742, components: 5272, fuel: 6123, rares: 4056, electronics: 4424, cash: 43234, manpower: 3744 },
    { day: 13, supplies: 11937, components: 5358, fuel: 6228, rares: 4086, electronics: 4494, cash: 43912, manpower: 3744 },
    { day: 14, supplies: 12116, components: 5430, fuel: 6322, rares: 4134, electronics: 4578, cash: 44469, manpower: 3774 },
    { day: 15, supplies: 12268, components: 5518, fuel: 6398, rares: 4184, electronics: 4638, cash: 44994, manpower: 3792 },
    { day: 16, supplies: 12381, components: 5544, fuel: 6460, rares: 4250, electronics: 4660, cash: 45258, manpower: 3792 },
    { day: 17, supplies: 12494, components: 5615, fuel: 6523, rares: 4296, electronics: 4710, cash: 45730, manpower: 3792 },
    { day: 18, supplies: 12656, components: 5694, fuel: 6604, rares: 4326, electronics: 4768, cash: 46276, manpower: 3807 },
    { day: 19, supplies: 12841, components: 5760, fuel: 6704, rares: 4374, electronics: 4831, cash: 46826, manpower: 3846 },
    { day: 20, supplies: 13012, components: 5853, fuel: 6794, rares: 4392, electronics: 4902, cash: 47304, manpower: 3864 },
    { day: 21, supplies: 13104, components: 5880, fuel: 6840, rares: 4407, electronics: 4937, cash: 47610, manpower: 3864 },
    { day: 22, supplies: 13141, components: 5922, fuel: 6866, rares: 4427, electronics: 4944, cash: 47738, manpower: 3864 },
    { day: 23, supplies: 13210, components: 5928, fuel: 6905, rares: 4459, electronics: 4959, cash: 47835, manpower: 3864 },
    { day: 24, supplies: 13224, components: 5943, fuel: 6912, rares: 4464, electronics: 4974, cash: 47904, manpower: 3864 },
    { day: 25, supplies: 13297, components: 5998, fuel: 6956, rares: 4470, electronics: 4994, cash: 48136, manpower: 3894 },
    { day: 26, supplies: 13344, components: 6000, fuel: 6984, rares: 4495, electronics: 5016, cash: 48216, manpower: 3912 },
    { day: 27, supplies: 13344, components: 6005, fuel: 6984, rares: 4512, electronics: 5031, cash: 48291, manpower: 3912 },
    { day: 28, supplies: 13421, components: 6024, fuel: 7030, rares: 4512, electronics: 5059, cash: 48412, manpower: 3912 },
  ]);
});
