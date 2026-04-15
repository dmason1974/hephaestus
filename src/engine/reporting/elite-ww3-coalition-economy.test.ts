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
  const scenarioId = "elite_ww3_2026";
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
    { day: 1, supplies: 9024, components: 4140, fuel: 4512, rares: 2994, electronics: 3295, cash: 34151, manpower: 2583 },
    { day: 2, supplies: 9641, components: 4399, fuel: 4933, rares: 3243, electronics: 3590, cash: 36343, manpower: 2997 },
    { day: 3, supplies: 10278, components: 4611, fuel: 5334, rares: 3456, electronics: 3873, cash: 38377, manpower: 3288 },
    { day: 4, supplies: 10571, components: 4740, fuel: 5497, rares: 3575, electronics: 4004, cash: 39325, manpower: 3447 },
    { day: 5, supplies: 10761, components: 4821, fuel: 5604, rares: 3692, electronics: 4065, cash: 40117, manpower: 3471 },
    { day: 6, supplies: 10950, components: 4916, fuel: 5703, rares: 3792, electronics: 4140, cash: 40758, manpower: 3480 },
    { day: 7, supplies: 11128, components: 4989, fuel: 5796, rares: 3825, electronics: 4206, cash: 41286, manpower: 3678 },
    { day: 8, supplies: 11312, components: 5094, fuel: 5896, rares: 3866, electronics: 4254, cash: 41799, manpower: 3711 },
    { day: 9, supplies: 11488, components: 5156, fuel: 5984, rares: 3917, electronics: 4333, cash: 42470, manpower: 3735 },
    { day: 10, supplies: 11617, components: 5223, fuel: 6056, rares: 3981, electronics: 4383, cash: 42801, manpower: 3744 },
    { day: 11, supplies: 11730, components: 5262, fuel: 6117, rares: 4038, electronics: 4422, cash: 43151, manpower: 3744 },
    { day: 12, supplies: 11908, components: 5350, fuel: 6206, rares: 4059, electronics: 4484, cash: 43793, manpower: 3744 },
    { day: 13, supplies: 12089, components: 5421, fuel: 6304, rares: 4101, electronics: 4550, cash: 44333, manpower: 3774 },
    { day: 14, supplies: 12252, components: 5508, fuel: 6390, rares: 4151, electronics: 4629, cash: 44880, manpower: 3792 },
    { day: 15, supplies: 12352, components: 5544, fuel: 6441, rares: 4217, electronics: 4656, cash: 45172, manpower: 3792 },
    { day: 16, supplies: 12476, components: 5582, fuel: 6514, rares: 4278, electronics: 4703, cash: 45619, manpower: 3792 },
    { day: 17, supplies: 12642, components: 5685, fuel: 6597, rares: 4296, electronics: 4758, cash: 46191, manpower: 3807 },
    { day: 18, supplies: 12812, components: 5742, fuel: 6682, rares: 4326, electronics: 4821, cash: 46709, manpower: 3831 },
    { day: 19, supplies: 12989, components: 5838, fuel: 6778, rares: 4374, electronics: 4891, cash: 47257, manpower: 3855 },
    { day: 20, supplies: 13096, components: 5871, fuel: 6836, rares: 4407, electronics: 4928, cash: 47529, manpower: 3864 },
    { day: 21, supplies: 13108, components: 5904, fuel: 6842, rares: 4418, electronics: 4944, cash: 47714, manpower: 3864 },
    { day: 22, supplies: 13183, components: 5928, fuel: 6887, rares: 4450, electronics: 4944, cash: 47751, manpower: 3864 },
    { day: 23, supplies: 13224, components: 5928, fuel: 6912, rares: 4464, electronics: 4959, cash: 47835, manpower: 3864 },
    { day: 24, supplies: 13252, components: 5971, fuel: 6926, rares: 4464, electronics: 4989, cash: 48049, manpower: 3876 },
    { day: 25, supplies: 13335, components: 6000, fuel: 6978, rares: 4485, electronics: 5009, cash: 48195, manpower: 3912 },
    { day: 26, supplies: 13344, components: 6000, fuel: 6984, rares: 4510, electronics: 5016, cash: 48216, manpower: 3912 },
    { day: 27, supplies: 13370, components: 6015, fuel: 6997, rares: 4512, electronics: 5041, cash: 48331, manpower: 3912 },
    { day: 28, supplies: 13455, components: 6046, fuel: 7047, rares: 4512, electronics: 5064, cash: 48447, manpower: 3912 },
  ]);
});
