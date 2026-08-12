import assert from "node:assert/strict";
import test from "node:test";

import type { ScenarioFile } from "../../schemas/scenario-schema.js";
import type { UnitCatalog } from "../../schemas/unit-schema.js";
import { computeGarrisonUpkeep } from "./garrison-upkeep.js";

const catalog = {
  units: {
    motorized_infantry: {
      levels: {
        "1": {
          daily_upkeep: {
            western: { cost: { manpower: 10, fuel: 5 } },
          },
        },
      },
    },
  },
} as unknown as UnitCatalog;

function scenarioWith(startingUnits: NonNullable<ScenarioFile["starting_units"]>): ScenarioFile {
  return {
    schema_version: 1,
    domain: "scenario",
    id: "test",
    name: "Test",
    start: { day: 1, hour: 0 },
    speed: "4x",
    starting_units: startingUnits,
  } as ScenarioFile;
}

test("computeGarrisonUpkeep sums catalog-unit upkeep over the disband window", () => {
  const scenario = scenarioWith([{ unit_id: "motorized_infantry", count: 14, level: 1 }]);
  const result = computeGarrisonUpkeep(scenario, catalog, "western", 0, 96); // 4 days = 96h

  assert.equal(result.hours, 96);
  assert.equal(result.units.length, 1);
  // 14 units * 10 manpower/day * 4 days
  assert.equal(result.totalUpkeep.manpower, 14 * 10 * 4);
  assert.equal(result.totalUpkeep.fuel, 14 * 5 * 4);
});

test("computeGarrisonUpkeep uses inline daily_upkeep for units not in the catalog, with doctrine fallback", () => {
  const scenario = scenarioWith([
    {
      unit_id: "gunship",
      count: 1,
      level: 1,
      daily_upkeep: {
        eastern: { manpower: 25, fuel: 25, electronics: 25, cash: 80 },
      },
    },
  ]);

  // Requested doctrine ("western") is absent — falls back to the only available entry (eastern).
  const result = computeGarrisonUpkeep(scenario, catalog, "western", 0, 24);

  assert.equal(result.units[0].dailyUpkeepPerUnit.manpower, 25);
  assert.equal(result.totalUpkeep.cash, 80);
});

test("computeGarrisonUpkeep falls back to another doctrine's data for a catalog unit missing the requested one", () => {
  // motorized_infantry only has western data in the fixture catalog (mirrors the
  // real elite/antarctica catalog pending eastern/european screenshots).
  const scenario = scenarioWith([{ unit_id: "motorized_infantry", count: 14, level: 1 }]);
  const result = computeGarrisonUpkeep(scenario, catalog, "eastern", 0, 96);

  assert.equal(result.totalUpkeep.manpower, 14 * 10 * 4);
});

test("computeGarrisonUpkeep returns zero cost when disbandAbsHour is at or before scenarioAbsHour", () => {
  const scenario = scenarioWith([{ unit_id: "motorized_infantry", count: 14, level: 1 }]);
  const result = computeGarrisonUpkeep(scenario, catalog, "western", 100, 100);

  assert.equal(result.hours, 0);
  assert.deepEqual(result.totalUpkeep, {});
});
