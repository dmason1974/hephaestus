import test from "node:test";
import assert from "node:assert/strict";

import { planProvinceMobilization } from "./province-mobilization-plan.js";
import type { UnitCatalog } from "../../schemas/unit-schema.js";
import type { BuildingsFile } from "../../schemas/building-schema.js";

// Synthetic unit_limit-gated unit (mirrors commando's shape: two tranches,
// each requiring its own mercenary_outpost level) — gives full control over
// timing without depending on real catalog data.
const testCatalog = {
  units: {
    test_commando: {
      levels: {
        "1": {
          requirements: ["mercenary_outpost level 1"],
          research: {},
          mobilisation: { western: { time: { hours: 10 }, cost: {}, unit_limit: 2 } },
          daily_upkeep: {},
        },
        "2": {
          requirements: ["mercenary_outpost level 2"],
          research: {},
          mobilisation: { western: { time: { hours: 10 }, cost: {}, unit_limit: 5 } },
          daily_upkeep: {},
        },
      },
    },
  },
} as unknown as UnitCatalog;

const testBuildings = {
  schema_version: 1,
  domain: "buildings",
  resources: ["supplies"],
  buildings: {
    mercenary_outpost: {
      name: "Mercenary Outpost",
      category: "Buildings",
      levels: {
        "1": { build_time: { hours: 5 }, cost: { supplies: 10 } },
        "2": { build_time: { hours: 5 }, cost: { supplies: 10 } },
      },
    },
  },
} as unknown as BuildingsFile;

test("planProvinceMobilization: deadlineHour omitted is a true no-op (matches an explicit Infinity)", () => {
  const args = {
    unitId: "test_commando",
    count: 5,
    provinceCount: 10,
    unitCatalog: testCatalog,
    buildings: testBuildings,
    doctrine: "western",
    mobilisationEarliestHourByLevel: { 1: 5, 2: 5 },
  };
  const omitted = planProvinceMobilization(args);
  const explicit = planProvinceMobilization({ ...args, deadlineHour: Infinity });
  assert.deepEqual(omitted, explicit);

  // And without any deadline pull, each tranche mobilises at its readiness
  // floor — the pre-fix behaviour this test locks in as still correct when
  // no deadline is supplied.
  for (const t of omitted.tranches) {
    const readinessFloor = Math.max(t.mercenaryOutpostCompleteHour, t.mobilisationEarliestHour);
    assert.equal(t.mobStartHour, readinessFloor);
  }
});

test("planProvinceMobilization: a distant deadline defers tranches well past their early readiness floor", () => {
  const result = planProvinceMobilization({
    unitId: "test_commando",
    count: 5,
    provinceCount: 10,
    unitCatalog: testCatalog,
    buildings: testBuildings,
    doctrine: "western",
    // Both tranches are ready very early...
    mobilisationEarliestHourByLevel: { 1: 5, 2: 5 },
    // ...but the deadline is far off — mobilising the instant they're ready
    // would leave hundreds of hours of avoidable upkeep exposure.
    deadlineHour: 1000,
  });

  const lastTranche = result.tranches[result.tranches.length - 1];
  // Never mobilises earlier than physically possible.
  for (const t of result.tranches) {
    const readinessFloor = Math.max(t.mercenaryOutpostCompleteHour, t.mobilisationEarliestHour);
    assert.ok(t.mobStartHour >= readinessFloor - 1e-9, `tranche L${t.level} started before its own readiness floor`);
  }
  // The last tranche should be pulled close to the deadline, not sitting at
  // its early readiness hour — this is the actual bug fix.
  assert.ok(
    lastTranche.completionHour > 900,
    `expected the last tranche to be deferred near the deadline (1000), got completionHour=${lastTranche.completionHour}`
  );
  assert.ok(lastTranche.completionHour <= 1000);
});

test("planProvinceMobilization: a tight deadline falls back to the readiness floor rather than mobilising early", () => {
  const noDeadline = planProvinceMobilization({
    unitId: "test_commando",
    count: 5,
    provinceCount: 10,
    unitCatalog: testCatalog,
    buildings: testBuildings,
    doctrine: "western",
    mobilisationEarliestHourByLevel: { 1: 5, 2: 5 },
  });

  // A deadline exactly at the natural (undeferred) completion leaves zero
  // slack for backward deferral — the readiness floor must win outright,
  // never producing an earlier-than-possible or negative-duration start.
  const tightDeadline = noDeadline.completionHour;
  const result = planProvinceMobilization({
    unitId: "test_commando",
    count: 5,
    provinceCount: 10,
    unitCatalog: testCatalog,
    buildings: testBuildings,
    doctrine: "western",
    mobilisationEarliestHourByLevel: { 1: 5, 2: 5 },
    deadlineHour: tightDeadline,
  });

  for (const t of result.tranches) {
    const readinessFloor = Math.max(t.mercenaryOutpostCompleteHour, t.mobilisationEarliestHour);
    assert.equal(t.mobStartHour, readinessFloor, `tranche L${t.level} should fall back to its readiness floor under a tight deadline`);
  }
});
