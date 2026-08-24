import assert from "node:assert/strict";
import test from "node:test";

import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCoalitionPlan } from "../../scenarios/io/load-coalition-plan.js";
import { loadMergedUnitCatalogForScenario } from "../../scenarios/io/load-unit-catalog.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import type { CityEcoResult } from "../eco/city-eco-beam.js";
import { runActualEcoBuild } from "../eco/actual-eco-build.js";
import { computeCountryForceProjection, classifyDemands, getBatchSize } from "./country-force-projection.js";
import { computePlanWeights } from "./joint-city-optimizer.js";
import { occupiedMoraleOnDay } from "../economy/morale.js";

test("computeCountryForceProjection produces a feasible plan with a sane flip point for Russia", () => {
  const scenarioId = "elite/antarctica";
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const catalog = loadMergedUnitCatalogForScenario(scenarioId);
  const plan = loadScenarioCoalitionPlan(scenarioId, "pnth-v-iron-2026-aug");
  const country = loadScenarioCountry(scenarioId, "russia");
  const countryPlan = plan.countries.russia;

  const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
  const deadlineAbsHour = scenarioAbsHour + plan.truce_days * 24;

  const result = computeCountryForceProjection({
    country,
    doctrine: country.country.doctrine,
    status: countryPlan.status,
    demands: countryPlan.demands,
    scenario,
    buildings,
    catalog,
    scenarioAbsHour,
    deadlineAbsHour,
    truceDays: plan.truce_days,
    maxRoLevel: 5,
  });

  assert.equal(result.infeasible, false);
  assert.ok(result.citySlots.length > 0, "should allocate at least one city");

  for (const slot of result.citySlots) {
    assert.ok(Number.isFinite(slot.flipPointAbsHour));
    assert.ok(slot.flipPointAbsHour >= scenarioAbsHour, "flip point cannot precede scenario start");
    // Infra construction starts exactly at the flip point.
    if (slot.infraSteps.length > 0) {
      assert.equal(slot.infraSteps[0].startHour, slot.flipPointAbsHour);
    }
    // Mobilisation can only begin once infra (built starting at the flip point) is done.
    if (slot.mobSteps.length > 0) {
      assert.ok(slot.mobSteps[0].startAbsHour >= slot.flipPointAbsHour);
    }
  }

  // Cost buckets should sum to the reported total.
  const { infraRo, infraBuildings, mobilisation, upkeep, provinceMobilisation, provinceUpkeep, total } = result.costs;
  for (const r of ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"] as const) {
    const summed = (infraRo[r] ?? 0) + (infraBuildings[r] ?? 0) + (mobilisation[r] ?? 0) + (upkeep[r] ?? 0)
      + (provinceMobilisation[r] ?? 0) + (provinceUpkeep[r] ?? 0);
    assert.ok(Math.abs(summed - (total[r] ?? 0)) < 1e-6, `cost buckets should sum to total for ${r}`);
  }
});

test("computeCountryForceProjection with researchBufferHours stays feasible and reserves idle slot time before every level 2+ research task (Italy)", () => {
  const scenarioId = "elite/antarctica";
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const catalog = loadMergedUnitCatalogForScenario(scenarioId);
  const plan = loadScenarioCoalitionPlan(scenarioId, "pnth-v-iron-2026-aug");
  const country = loadScenarioCountry(scenarioId, "italy");
  const countryPlan = plan.countries.italy;
  const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
  const deadlineAbsHour = scenarioAbsHour + plan.truce_days * 24;

  const baseArgs = {
    country, doctrine: country.country.doctrine, status: countryPlan.status,
    demands: countryPlan.demands,
    scenario, buildings, catalog,
    scenarioAbsHour, deadlineAbsHour,
    truceDays: plan.truce_days,
    maxRoLevel: 5,
  };

  const withoutBuffer = computeCountryForceProjection(baseArgs);
  const withBuffer = computeCountryForceProjection({ ...baseArgs, researchBufferHours: 24 });

  assert.equal(withoutBuffer.infeasible, false);
  assert.equal(withBuffer.infeasible, false);

  const bySlot = new Map<number, typeof withBuffer.researchSegments>();
  for (const segment of withBuffer.researchSegments) {
    if (!bySlot.has(segment.slot)) bySlot.set(segment.slot, []);
    bySlot.get(segment.slot)!.push(segment);
  }
  for (const segments of bySlot.values()) {
    segments.sort((a, b) => a.startAbsoluteHour - b.startAbsoluteHour);
    for (let i = 1; i < segments.length; i++) {
      if (segments[i].level < 2) continue;
      const gap = segments[i].startAbsoluteHour - segments[i - 1].endAbsoluteHourExclusive;
      assert.ok(gap >= 24, `expected >=24h gap before ${segments[i].unitId} L${segments[i].level}, got ${gap}h`);
    }
  }
});

test("computeCountryForceProjection defaults every unit's L1 and helicopter_gunship/air_superiority_fighter's full chain to ASAP, with no YAML pins, and buffers everything else (Japan)", () => {
  const scenarioId = "elite/antarctica";
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const catalog = loadMergedUnitCatalogForScenario(scenarioId);
  const plan = loadScenarioCoalitionPlan(scenarioId, "pnth-v-iron-2026-aug");
  const country = loadScenarioCountry(scenarioId, "japan");
  const countryPlan = plan.countries.japan;
  const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
  const deadlineAbsHour = scenarioAbsHour + plan.truce_days * 24;

  assert.equal(countryPlan.research_asap_pins, undefined, "fixture assumption: Japan's plan no longer needs research_asap_pins — the engine defaults this now");

  const result = computeCountryForceProjection({
    country, doctrine: country.country.doctrine, status: countryPlan.status,
    demands: countryPlan.demands,
    scenario, buildings, catalog,
    scenarioAbsHour, deadlineAbsHour,
    truceDays: plan.truce_days,
    maxRoLevel: 5,
    researchBufferHours: plan.research_buffer_hours,
  });

  assert.equal(result.infeasible, false);

  // Every ASAP-eligible level must actually be present — the original
  // (slot-unaware) ASAP-completion computation silently dropped
  // awacs:1/air_superiority_fighter:1 here (infeasible override due to real
  // 2-slot contention among the ASAP-eligible units), leaving their
  // already-scheduled higher levels dangling. This is the regression guard for
  // that bug: helicopter_gunship and air_superiority_fighter have zero own
  // mobilised demand (pure research prerequisites — for elite_attack_helicopter
  // and stealth_air_superiority_fighter respectively), so ALL their levels are
  // ASAP-eligible by default; every other demanded unit's own level 1 is too.
  const asapEligible: Array<[string, number]> = [
    ...([1, 2, 3, 4, 5, 6] as const).map((l): [string, number] => ["helicopter_gunship", l]),
    ...([1, 2, 3, 4] as const).map((l): [string, number] => ["air_superiority_fighter", l]),
    ["elite_attack_helicopter", 1], ["fixed_wing_veteran", 1], ["awacs", 1], ["stealth_air_superiority_fighter", 1],
  ];
  const byUnitLevel = new Map(result.researchSegments.map(s => [`${s.unitId}:${s.level}`, s]));
  for (const [unit, level] of asapEligible) {
    assert.ok(byUnitLevel.has(`${unit}:${level}`), `ASAP-eligible ${unit}:${level} must be scheduled, not silently dropped`);
  }

  // helicopter_gunship is never mobilised (zero upkeep benefit to deferring it),
  // so it should land level 1 well before the deadline-JIT backward scheduler
  // would otherwise place it — the pre-fix baseline deferred it to day 17 of a
  // 28-day truce (hour ~380+). It won't necessarily land within a day or two of
  // scenario start, though: it's one of many ASAP-eligible tasks (the full
  // air_superiority_fighter chain, awacs L1, fixed_wing_veteran L1,
  // elite_attack_helicopter L1, stealth_air_superiority_fighter L1, gunship's
  // own L2-L6) all genuinely competing for only 2 slots, each level-2+ task
  // among them also paying the same 24h buffer as everything else — so a
  // legitimately-earned hour somewhat later than scenario start is expected and
  // correct, not a bug. The meaningful assertion is "nowhere near day 17".
  const gunshipL1 = byUnitLevel.get("helicopter_gunship:1");
  assert.ok(gunshipL1);
  assert.ok(
    gunshipL1!.startAbsoluteHour <= scenarioAbsHour + 200,
    `helicopter_gunship L1 should start well before the old day-17 JIT-deferred baseline, got hour ${gunshipL1!.startAbsoluteHour} (scenario start ${scenarioAbsHour})`
  );

  // The 24h research buffer applies uniformly to every level 2+ task now,
  // ASAP-eligible or not (see country-force-projection.ts's ASAP-default
  // comment — an across-the-board buffer exemption for ASAP chains was
  // specific to the old hand-pinned Iron workaround, not a real domain rule:
  // the buffer models real player reaction time, which doesn't care which
  // economic strategy placed a task). So gunship's own chain should schedule
  // MEASURABLY TIGHTER with the buffer removed, not identically — the
  // opposite of what this test asserted before that direction was corrected.
  const withoutBuffer = computeCountryForceProjection({
    country, doctrine: country.country.doctrine, status: countryPlan.status,
    demands: countryPlan.demands,
    scenario, buildings, catalog,
    scenarioAbsHour, deadlineAbsHour,
    truceDays: plan.truce_days,
    maxRoLevel: 5,
  });
  const byUnitLevelNoBuffer = new Map(withoutBuffer.researchSegments.map(s => [`${s.unitId}:${s.level}`, s]));
  let sawTighterWithoutBuffer = false;
  for (let level = 1; level <= 6; level++) {
    const withBuffer = byUnitLevel.get(`helicopter_gunship:${level}`);
    const noBuffer = byUnitLevelNoBuffer.get(`helicopter_gunship:${level}`);
    assert.ok(withBuffer && noBuffer);
    assert.ok(
      noBuffer!.startAbsoluteHour <= withBuffer!.startAbsoluteHour,
      `helicopter_gunship L${level} should never start LATER without the buffer than with it`
    );
    if (noBuffer!.startAbsoluteHour < withBuffer!.startAbsoluteHour) sawTighterWithoutBuffer = true;
  }
  assert.ok(sawTighterWithoutBuffer, "expected at least one helicopter_gunship level to schedule tighter without the buffer, proving the buffer genuinely applies to ASAP-eligible chains now");

  // awacs level 2+ and fixed_wing_veteran level 2+ are NOT ASAP-eligible (real
  // own demand, genuinely JIT-deferred) — they must show the buffer whenever
  // they immediately follow another segment in the same slot.
  const bySlot = new Map<number, typeof result.researchSegments>();
  for (const segment of result.researchSegments) {
    if (!bySlot.has(segment.slot)) bySlot.set(segment.slot, []);
    bySlot.get(segment.slot)!.push(segment);
  }
  let sawBufferedTransition = false;
  for (const segments of bySlot.values()) {
    segments.sort((a, b) => a.startAbsoluteHour - b.startAbsoluteHour);
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      const isUnpinnedNonPrimary =
        (seg.unitId === "awacs" || seg.unitId === "fixed_wing_veteran") && seg.level >= 2;
      if (!isUnpinnedNonPrimary) continue;
      const gap = seg.startAbsoluteHour - segments[i - 1].endAbsoluteHourExclusive;
      assert.ok(gap >= 24, `expected >=24h buffer before ${seg.unitId} L${seg.level}, got ${gap}h`);
      sawBufferedTransition = true;
    }
  }
  assert.ok(sawBufferedTransition, "expected at least one buffered awacs/fixed_wing_veteran transition in the real Japan plan");
});

test("computeCountryForceProjection returns reason 'no_demands' when the country has no demands", () => {
  const scenarioId = "elite/antarctica";
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const catalog = loadMergedUnitCatalogForScenario(scenarioId);
  const country = loadScenarioCountry(scenarioId, "russia");
  const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);

  const result = computeCountryForceProjection({
    country,
    doctrine: country.country.doctrine,
    status: "homeland",
    demands: [],
    scenario,
    buildings,
    catalog,
    scenarioAbsHour,
    deadlineAbsHour: scenarioAbsHour + 28 * 24,
    truceDays: 28,
    maxRoLevel: 5,
  });

  assert.equal(result.reason, "no_demands");
  assert.equal(result.infeasible, true);
  assert.equal(result.citySlots.length, 0);
});

test("computeCountryForceProjection reports the occupied morale curve, not a flat 50, for an occupied country with no demands", () => {
  const scenarioId = "elite/antarctica";
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const catalog = loadMergedUnitCatalogForScenario(scenarioId);
  const country = loadScenarioCountry(scenarioId, "russia");
  const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);

  const result = computeCountryForceProjection({
    country,
    doctrine: country.country.doctrine,
    status: "occupied",
    demands: [],
    scenario,
    buildings,
    catalog,
    scenarioAbsHour,
    deadlineAbsHour: scenarioAbsHour + 28 * 24,
    truceDays: 28,
    maxRoLevel: 5,
  });

  assert.equal(result.infeasible, true);
  assert.equal(result.reason, "no_demands");
  assert.equal(result.moraleAtStart, occupiedMoraleOnDay(1));
  assert.notEqual(result.moraleAtStart, 50);
});

test("classifyDemands routes units with no mobilisation data for the given doctrine to missingDataDemands, not launcherDemands", () => {
  // Synthetic minimal catalog rather than a real unit — real catalog data is
  // actively being filled in (e.g. fixed_wing_veteran and mobile_sam_launcher both
  // had this exact gap earlier in the same session this fix landed, then got their
  // missing doctrine's data added), so any real-unit fixture risks silently starting
  // to test nothing as the data gap it depends on gets closed. This regression test
  // is for the bug where missing-doctrine-data units were silently misclassified as
  // zero-mob-cost launcher platforms (same 0 returned by unitMobTimeHours for both
  // "no data" and "genuinely instant") and dropped from the plan without any warning.
  const catalog = {
    units: {
      gap_unit: {
        levels: {
          "1": {
            requirements: [],
            research: {},
            mobilisation: { western: { time: { hours: 1 }, cost: {} } },
            daily_upkeep: {},
          },
        },
      },
    },
  } as unknown as Parameters<typeof classifyDemands>[2];

  const result = classifyDemands([{ unitId: "gap_unit", count: 1 }], "eastern", catalog);

  assert.equal(result.missingDataDemands.length, 1);
  assert.equal(result.missingDataDemands[0].unitId, "gap_unit");
  assert.equal(result.launcherDemands.length, 0);
  assert.equal(result.activeDemands.length, 0);
});

test("classifyDemands still routes a genuine zero-mob-cost launcher platform to launcherDemands", () => {
  const scenarioId = "elite/antarctica";
  const catalog = loadMergedUnitCatalogForScenario(scenarioId);
  const plan = loadScenarioCoalitionPlan(scenarioId, "pnth-v-iron-2026-aug");
  const country = loadScenarioCountry(scenarioId, "india");
  const doctrine = country.country.doctrine;

  // India's demands include conventional_cruise_missile, a genuine zero-mob-time
  // launcher platform (real data exists, time is just 0) — must stay classified as
  // a launcher, not get swept into missingDataDemands.
  const result = classifyDemands(plan.countries.india.demands, doctrine, catalog);

  const cruiseMissileDemand = plan.countries.india.demands.find(d => d.unitId === "conventional_cruise_missile");
  assert.ok(cruiseMissileDemand, "fixture assumption: India demands conventional_cruise_missile");
  assert.ok(result.launcherDemands.some(d => d.unitId === "conventional_cruise_missile"));
  assert.ok(!result.missingDataDemands.some(d => d.unitId === "conventional_cruise_missile"));
});

test("computeCountryForceProjection credits eco-built levels and forces RO first when actualEcoResultsByCity is supplied", () => {
  const scenarioId = "elite/antarctica";
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const catalog = loadMergedUnitCatalogForScenario(scenarioId);
  const plan = loadScenarioCoalitionPlan(scenarioId, "pnth-v-iron-2026-aug");
  const country = loadScenarioCountry(scenarioId, "italy");
  const countryPlan = plan.countries.italy;
  const doctrine = country.country.doctrine;

  const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
  const deadlineAbsHour = scenarioAbsHour + plan.truce_days * 24;
  const hoursToSimulate = plan.truce_days * 24;

  const { activeDemands } = classifyDemands(countryPlan.demands, doctrine, catalog);
  const planWeights = computePlanWeights(
    activeDemands.map(d => ({ unitId: d.unitId, effectiveCount: Math.ceil(d.count / getBatchSize(d.unitId, catalog)) })),
    catalog, doctrine, plan.truce_days,
  );

  const baseline = computeCountryForceProjection({
    country, doctrine, status: countryPlan.status,
    demands: countryPlan.demands,
    scenario, buildings, catalog,
    scenarioAbsHour, deadlineAbsHour,
    truceDays: plan.truce_days,
    maxRoLevel: 5,
    planWeights,
  });

  const actualEco = runActualEcoBuild(
    country, scenario, buildings,
    { hoursToSimulate, beamWidth: 10, topN: 3, unconstrained: true },
    countryPlan.status, undefined, planWeights,
  );
  const actualEcoResultsByCity = new Map<string, CityEcoResult>(
    actualEco.cityResults.map(r => [r.cityId.slice(r.cityId.indexOf(":") + 1), r]),
  );

  const ecoCredited = computeCountryForceProjection({
    country, doctrine, status: countryPlan.status,
    demands: countryPlan.demands,
    scenario, buildings, catalog,
    scenarioAbsHour, deadlineAbsHour,
    truceDays: plan.truce_days,
    maxRoLevel: 5,
    planWeights,
    actualEcoResultsByCity,
  });

  assert.equal(ecoCredited.infeasible, false);
  assert.ok(ecoCredited.citySlots.length > 0);

  // relocate_headquarters must never appear in the actual eco build for more than
  // one city (structural cap — was previously built independently in every city).
  const hqBuildCities = actualEco.cityResults.filter(r =>
    r.bestActions.some(a => a.buildingId === "relocate_headquarters"),
  );
  assert.ok(hqBuildCities.length <= 1, "relocate_headquarters should be built in at most one city");

  // RO L1 must be the very first eco build action in every city (settled UAT rule).
  for (const cityResult of actualEco.cityResults) {
    assert.equal(cityResult.bestActions[0]?.buildingId, "recruiting_office");
    assert.equal(cityResult.bestActions[0]?.targetLevel, 1);
  }

  const baselineByCity = new Map(baseline.citySlots.map(s => [s.cityId, s]));

  for (const slot of ecoCredited.citySlots) {
    // RO must be first whenever it's still required and not yet fully backfilled —
    // checked across the combined, chronologically-sorted backfill+infra sequence,
    // since RO may now be fully absorbed into ecoBackfillSteps (pulled forward into
    // idle eco-phase time) rather than appearing in infraSteps at all.
    if (slot.roLevel > 0) {
      const combined = [...slot.ecoBackfillSteps, ...slot.infraSteps].sort((a, b) => a.startHour - b.startHour);
      const roStillNeeded = combined.some(s => s.buildingId === "recruiting_office");
      if (roStillNeeded) {
        assert.equal(combined[0].buildingId, "recruiting_office", `RO should be first in the combined backfill+infra sequence for ${slot.cityId}`);
      }
    }
    // Infra construction starts exactly at the (eco-credited) flip point.
    if (slot.infraSteps.length > 0) {
      assert.equal(slot.infraSteps[0].startHour, slot.flipPointAbsHour);
    }
    // Backfilled steps must never duplicate into the post-flip chain (structural
    // de-dup: once a level is credited via the augmented eco result fed into
    // computeFlipPoint, buildRemainingChain can no longer emit it).
    for (const b of slot.ecoBackfillSteps) {
      assert.ok(
        !slot.infraSteps.some(s => s.buildingId === b.buildingId && s.toLevel === b.toLevel),
        `backfilled ${b.buildingId} L${b.toLevel} for ${slot.cityId} must not also appear in infraSteps`,
      );
      assert.ok(b.endHour <= slot.flipPointAbsHour, `backfilled step for ${slot.cityId} must complete at or before the flip point`);
    }

    // Eco-crediting should never make the chain longer than building from scratch —
    // city assignment (foldInDemands) is eco-unaware and identical given the same
    // planWeights, so this is a like-for-like comparison of the same city/unit/RO combo.
    const baselineSlot = baselineByCity.get(slot.cityId);
    if (baselineSlot) {
      const ecoTotalHours = slot.infraSteps.reduce((s, step) => s + step.durH, 0);
      const baselineTotalHours = baselineSlot.infraSteps.reduce((s, step) => s + step.durH, 0);
      assert.ok(
        ecoTotalHours <= baselineTotalHours + 1e-6,
        `eco-credited infra chain for ${slot.cityId} (${ecoTotalHours}h) should not exceed the formula-based chain (${baselineTotalHours}h)`,
      );
    }
  }
});

// ── Dead-window cities (SASF + warhead/uav/awacs sharing a queue) ───────────

test("computeCountryForceProjection: India's SASF demand pins to exactly Mumbai/Kolkata/New Delhi, splitting the 34-unit count across them", () => {
  const scenarioId = "elite/antarctica";
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const catalog = loadMergedUnitCatalogForScenario(scenarioId);
  const plan = loadScenarioCoalitionPlan(scenarioId, "pnth-v-iron-2026-aug");
  const country = loadScenarioCountry(scenarioId, "india");
  const countryPlan = plan.countries.india;
  const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
  const deadlineAbsHour = scenarioAbsHour + plan.truce_days * 24;

  const result = computeCountryForceProjection({
    country, doctrine: country.country.doctrine, status: countryPlan.status,
    demands: countryPlan.demands,
    scenario, buildings, catalog,
    scenarioAbsHour, deadlineAbsHour,
    truceDays: plan.truce_days,
    maxRoLevel: 5,
  });

  const sasfDemand = countryPlan.demands.find(d => d.unitId === "stealth_air_superiority_fighter");
  assert.ok(sasfDemand, "fixture assumption: India demands stealth_air_superiority_fighter");
  assert.deepEqual(sasfDemand!.preferred_cities, ["mumbai", "kolkata", "new_delhi"]);

  const sasfSlots = result.citySlots.filter(s => s.primaryUnitId === "stealth_air_superiority_fighter");
  assert.deepEqual(sasfSlots.map(s => s.cityId).sort(), ["kolkata", "mumbai", "new_delhi"]);
  const totalSasf = sasfSlots.reduce(
    (s, slot) => s + slot.mobQueue.filter(e => e.unitId === "stealth_air_superiority_fighter").reduce((s2, e) => s2 + e.count, 0),
    0,
  );
  assert.equal(totalSasf, sasfDemand!.count);
});

test("computeCountryForceProjection: India's dead-window SASF cities mobilise uav well before the primary unit's own readiness, using otherwise-idle mob-queue capacity", () => {
  const scenarioId = "elite/antarctica";
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const catalog = loadMergedUnitCatalogForScenario(scenarioId);
  const plan = loadScenarioCoalitionPlan(scenarioId, "pnth-v-iron-2026-aug");
  const country = loadScenarioCountry(scenarioId, "india");
  const countryPlan = plan.countries.india;
  const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
  const deadlineAbsHour = scenarioAbsHour + plan.truce_days * 24;

  const result = computeCountryForceProjection({
    country, doctrine: country.country.doctrine, status: countryPlan.status,
    demands: countryPlan.demands,
    scenario, buildings, catalog,
    scenarioAbsHour, deadlineAbsHour,
    truceDays: plan.truce_days,
    maxRoLevel: 5,
  });

  const mumbai = result.citySlots.find(s => s.cityId === "mumbai");
  assert.ok(mumbai, "fixture assumption: mumbai is a pinned SASF city");
  const uavStep = mumbai!.mobSteps.find(s => s.unitId === "uav");
  const sasfStep = mumbai!.mobSteps.find(s => s.unitId === "stealth_air_superiority_fighter");
  assert.ok(uavStep, "uav should have been absorbed into the SASF city's mob queue (merged pinned-demand slot)");
  assert.ok(sasfStep);
  assert.ok(
    uavStep!.endAbsHour <= sasfStep!.startAbsHour,
    "uav must fully mobilise before SASF starts (queue is sequential — this only checks ordering, not the dead-window timing claim below)",
  );
  // The real claim: uav starts near air_base L1/arms_industry L1 completion (its
  // own, much smaller, requirement set), not near the FULL air_base L5 chain
  // completion SASF itself needs (which is what the old shared-infraOpenHour bug
  // would have produced).
  const airBaseL5Step = mumbai!.infraSteps.find(s => s.buildingId === "air_base" && s.toLevel >= 5);
  assert.ok(airBaseL5Step);
  assert.ok(
    uavStep!.startAbsHour < airBaseL5Step!.endHour,
    `uav should start well before air_base L5 completes (${airBaseL5Step!.endHour}), not near the end of the full chain — got ${uavStep!.startAbsHour}`,
  );
});

test("computeCountryForceProjection: India's dead-window build order puts secret_weapons_lab before recruiting_office's remaining levels", () => {
  const scenarioId = "elite/antarctica";
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const catalog = loadMergedUnitCatalogForScenario(scenarioId);
  const plan = loadScenarioCoalitionPlan(scenarioId, "pnth-v-iron-2026-aug");
  const country = loadScenarioCountry(scenarioId, "india");
  const countryPlan = plan.countries.india;
  const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
  const deadlineAbsHour = scenarioAbsHour + plan.truce_days * 24;

  const result = computeCountryForceProjection({
    country, doctrine: country.country.doctrine, status: countryPlan.status,
    demands: countryPlan.demands,
    scenario, buildings, catalog,
    scenarioAbsHour, deadlineAbsHour,
    truceDays: plan.truce_days,
    maxRoLevel: 5,
  });

  const mumbai = result.citySlots.find(s => s.cityId === "mumbai");
  assert.ok(mumbai);
  const secretLabStep = mumbai!.infraSteps.find(s => s.buildingId === "secret_weapons_lab");
  const roL2Step = mumbai!.infraSteps.find(s => s.buildingId === "recruiting_office" && s.toLevel >= 2);
  assert.ok(secretLabStep, "fixture assumption: secret_weapons_lab is in Mumbai's infra chain (formula-based, no eco credit in this test)");
  if (roL2Step) {
    assert.ok(
      secretLabStep!.startHour < roL2Step.startHour,
      "secret_weapons_lab must be scheduled before recruiting_office's remaining levels in a dead-window city",
    );
  }
});

test("computeCountryForceProjection: a non-dead-window city (single unit type queue) keeps the default RO-first build order, unaffected", () => {
  const scenarioId = "elite/antarctica";
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const catalog = loadMergedUnitCatalogForScenario(scenarioId);
  const plan = loadScenarioCoalitionPlan(scenarioId, "pnth-v-iron-2026-aug");
  const country = loadScenarioCountry(scenarioId, "india");
  const countryPlan = plan.countries.india;
  const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
  const deadlineAbsHour = scenarioAbsHour + plan.truce_days * 24;

  const result = computeCountryForceProjection({
    country, doctrine: country.country.doctrine, status: countryPlan.status,
    demands: countryPlan.demands,
    scenario, buildings, catalog,
    scenarioAbsHour, deadlineAbsHour,
    truceDays: plan.truce_days,
    maxRoLevel: 5,
  });

  // bengaluru/chennai are pure conventional_warhead overflow cities (single unit
  // type in the queue) — isDeadWindowSlot requires >= 2 distinct unit types, so
  // these must use the default (RO-first) ordering, not the dead-window one.
  const warheadOnlyCity = result.citySlots.find(
    s => s.primaryUnitId === "conventional_warhead" && s.mobQueue.every(e => e.unitId === "conventional_warhead"),
  );
  assert.ok(warheadOnlyCity, "fixture assumption: at least one pure-warhead overflow city exists");
  if (warheadOnlyCity!.infraSteps.length > 0) {
    assert.equal(warheadOnlyCity!.infraSteps[0].buildingId, "recruiting_office", "non-dead-window cities keep RO first");
  }
});
