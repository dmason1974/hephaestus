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
    { day: 3, supplies: 10076, components: 4607, fuel: 5228, rares: 3437, electronics: 3796, cash: 38034, manpower: 3270 },
    { day: 4, supplies: 10533, components: 4711, fuel: 5478, rares: 3562, electronics: 3979, cash: 39268, manpower: 3375 },
    { day: 5, supplies: 10733, components: 4821, fuel: 5590, rares: 3680, electronics: 4062, cash: 39977, manpower: 3471 },
    { day: 6, supplies: 10912, components: 4894, fuel: 5684, rares: 3765, electronics: 4114, cash: 40645, manpower: 3480 },
    { day: 7, supplies: 11084, components: 4989, fuel: 5770, rares: 3810, electronics: 4197, cash: 41244, manpower: 3543 },
    { day: 8, supplies: 11269, components: 5074, fuel: 5871, rares: 3849, electronics: 4254, cash: 41748, manpower: 3711 },
    { day: 9, supplies: 11456, components: 5142, fuel: 5968, rares: 3899, electronics: 4302, cash: 42324, manpower: 3735 },
    { day: 10, supplies: 11561, components: 5207, fuel: 6028, rares: 3968, electronics: 4378, cash: 42784, manpower: 3744 },
    { day: 11, supplies: 11708, components: 5262, fuel: 6106, rares: 4030, electronics: 4422, cash: 43149, manpower: 3744 },
    { day: 12, supplies: 11874, components: 5336, fuel: 6189, rares: 4056, electronics: 4470, cash: 43609, manpower: 3744 },
    { day: 13, supplies: 12051, components: 5406, fuel: 6285, rares: 4086, electronics: 4539, cash: 44298, manpower: 3774 },
    { day: 14, supplies: 12234, components: 5486, fuel: 6381, rares: 4134, electronics: 4620, cash: 44871, manpower: 3792 },
    { day: 15, supplies: 12304, components: 5544, fuel: 6416, rares: 4199, electronics: 4656, cash: 45147, manpower: 3792 },
    { day: 16, supplies: 12441, components: 5574, fuel: 6490, rares: 4259, electronics: 4686, cash: 45527, manpower: 3792 },
    { day: 17, supplies: 12624, components: 5667, fuel: 6588, rares: 4296, electronics: 4756, cash: 46103, manpower: 3807 },
    { day: 18, supplies: 12786, components: 5742, fuel: 6669, rares: 4326, electronics: 4816, cash: 46684, manpower: 3831 },
    { day: 19, supplies: 12959, components: 5820, fuel: 6763, rares: 4374, electronics: 4878, cash: 47233, manpower: 3855 },
    { day: 20, supplies: 13062, components: 5871, fuel: 6819, rares: 4407, electronics: 4917, cash: 47469, manpower: 3864 },
    { day: 21, supplies: 13104, components: 5880, fuel: 6840, rares: 4416, electronics: 4937, cash: 47619, manpower: 3864 },
    { day: 22, supplies: 13141, components: 5922, fuel: 6866, rares: 4427, electronics: 4944, cash: 47738, manpower: 3864 },
    { day: 23, supplies: 13210, components: 5928, fuel: 6905, rares: 4459, electronics: 4959, cash: 47835, manpower: 3864 },
    { day: 24, supplies: 13224, components: 5943, fuel: 6912, rares: 4464, electronics: 4974, cash: 47919, manpower: 3864 },
    { day: 25, supplies: 13297, components: 5998, fuel: 6956, rares: 4479, electronics: 4994, cash: 48145, manpower: 3894 },
    { day: 26, supplies: 13344, components: 6000, fuel: 6984, rares: 4495, electronics: 5016, cash: 48216, manpower: 3912 },
    { day: 27, supplies: 13344, components: 6005, fuel: 6984, rares: 4512, electronics: 5031, cash: 48291, manpower: 3912 },
    { day: 28, supplies: 13421, components: 6024, fuel: 7030, rares: 4512, electronics: 5059, cash: 48427, manpower: 3912 },
  ]);
});
