import test from "node:test";
import assert from "node:assert/strict";

import {
  parseScenarioFile,
  scenarioResearchUnlockedThroughDayAtStart,
  scenarioTruceLengthDays,
} from "./scenario-schema.js";

test("scenario schema accepts elite ww3 4x1.4 speed", () => {
  const scenario = parseScenarioFile({
    schema_version: 1,
    domain: "scenario",
    id: "elite_ww3_2026",
    name: "Elite WW3 2026",
    start: {
      day: 1,
      hour: 15,
    },
    truce_length_days: 28,
    speed: "4x1.4",
    starting_balance: {
      supplies: 0,
      components: 0,
      fuel: 0,
      rares: 0,
      electronics: 0,
      cash: 0,
      manpower: 0,
    },
  });

  assert.equal(scenario.speed, "4x1.4");
  assert.equal(scenarioTruceLengthDays(scenario), 28);
});

test("scenario schema accepts research unlock day offset", () => {
  const scenario = parseScenarioFile({
    schema_version: 1,
    domain: "scenario",
    id: "elite_ww3_2026",
    name: "Elite WW3 2026",
    start: {
      day: 1,
      hour: 15,
    },
    truce_length_days: 28,
    speed: "4x1.4",
    starting_balance: {
      supplies: 0,
      components: 0,
      fuel: 0,
      rares: 0,
      electronics: 0,
      cash: 0,
      manpower: 0,
    },
    research: {
      unlocked_through_day_at_start: 9,
    },
  });

  assert.equal(scenarioResearchUnlockedThroughDayAtStart(scenario), 9);
});
