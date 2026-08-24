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
import {
  computeCountryForceProjection,
  classifyDemands,
  getBatchSize,
  splitMobBatchByLevel,
  getUnitBuildingRequirements,
  type LevelStep,
} from "./country-force-projection.js";
import { computePlanWeights } from "./joint-city-optimizer.js";
import { baselineHomelandMoraleOnDay } from "../economy/morale.js";
import { calculateMobilizationCost, resourceCostToScalar } from "./cost-calculator.js";

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

  // Feasible: every unit's level 1 (and every level of a unit with zero own
  // mobilised demand) is now scheduled ASAP by default rather than drifting
  // to whatever the JIT backward-fill's upper bound happened to allow. Before
  // this fix, special_forces' L1 research (pinned to Samara) landed around
  // day 14 — needlessly late, since research cost is unaffected by when it
  // completes — starving the rest of its sequential L2-L5 chain of runway and
  // pushing L5's real, research-level-split mobEnd 17h past the deadline. L1
  // now completes on day ~1.6, and the recovered slack (~12 days) comfortably
  // absorbs the rest of the chain.
  assert.equal(result.infeasible, false);
  assert.equal(result.overrunDemands.length, 0, "expected no deadline overruns for Russia's real plan");
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

  // Feasible under both settings — see the Russia test's comment above for
  // why (default ASAP level-1 scheduling recovers the runway the old
  // JIT-drifted-L1 behaviour wasted). This test's actual purpose (the
  // bufferHours gap-spacing assertion below) is independent of feasibility
  // and still holds either way.
  assert.equal(withoutBuffer.infeasible, false);
  assert.equal(withBuffer.infeasible, false);
  assert.equal(withoutBuffer.overrunDemands.length, 0);
  assert.equal(withBuffer.overrunDemands.length, 0);

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

test("computeCountryForceProjection with research_asap_pins packs Japan's helicopter_gunship/EAH chain tight and buffers everything else (Japan)", () => {
  const scenarioId = "elite/antarctica";
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const catalog = loadMergedUnitCatalogForScenario(scenarioId);
  const plan = loadScenarioCoalitionPlan(scenarioId, "pnth-v-iron-2026-aug");
  const country = loadScenarioCountry(scenarioId, "japan");
  const countryPlan = plan.countries.japan;
  const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
  const deadlineAbsHour = scenarioAbsHour + plan.truce_days * 24;

  // Japan's plan no longer carries research_asap_pins in its YAML (removed
  // 2026-08-24 — every entry here is now redundant with the engine's default
  // ASAP rule: helicopter_gunship has zero own demand so all 6 of its levels
  // auto-qualify, and the rest only ever pinned their own level 1, which every
  // demanded unit gets by default). Kept here as an inline fixture so the
  // hand-pin mechanism itself (`researchAsapPins`, still a real, supported
  // capability for cases the auto rule can't reach) stays covered by a real,
  // complex multi-unit scenario rather than only a synthetic one.
  const testAsapPins = [
    { unit: "helicopter_gunship", levels: [1, 2, 3, 4, 5, 6] },
    { unit: "elite_attack_helicopter", levels: [1] },
    { unit: "fixed_wing_veteran", levels: [1] },
    { unit: "awacs", levels: [1] },
    { unit: "air_superiority_fighter", levels: [1] },
  ];

  const result = computeCountryForceProjection({
    country, doctrine: country.country.doctrine, status: countryPlan.status,
    demands: countryPlan.demands,
    scenario, buildings, catalog,
    scenarioAbsHour, deadlineAbsHour,
    truceDays: plan.truce_days,
    maxRoLevel: 5,
    researchBufferHours: plan.research_buffer_hours,
    researchAsapPins: testAsapPins,
  });

  // Genuinely infeasible for Japan's real plan, not a regression — see the
  // Russia test's comment above for the root cause. elite_attack_helicopter's
  // unit_limit-gated tranches (5@L1, 5@L2) compound this: L2's own research
  // doesn't complete until late in the window, and once real per-level
  // mobilisation duration is used for the tranche mobilising at that point,
  // it genuinely can't finish by the deadline — this is exactly the "unit_limit
  // research deadlines are real constraints, not purely cost-deferrable"
  // complexity flagged in CLAUDE.md's deferred joint-scheduler item.
  assert.equal(result.infeasible, true);
  assert.ok(result.overrunDemands.length > 0);

  // Every pinned level must actually be present — the original (slot-unaware)
  // ASAP-completion computation silently dropped awacs:1/air_superiority_fighter:1
  // here (infeasible override due to real 2-slot contention among the pinned
  // chains), leaving their already-scheduled higher levels dangling. This is the
  // regression guard for that bug.
  const byUnitLevel = new Map(result.researchSegments.map(s => [`${s.unitId}:${s.level}`, s]));
  for (const pin of testAsapPins) {
    for (const level of pin.levels) {
      assert.ok(byUnitLevel.has(`${pin.unit}:${level}`), `pinned ${pin.unit}:${level} must be scheduled, not silently dropped`);
    }
  }

  // helicopter_gunship is never mobilised (zero upkeep benefit to deferring it),
  // so its pin should land level 1 well before the deadline-JIT backward
  // scheduler would otherwise leave it — not deferred to whenever leftover slot
  // room appears, which is what the pre-pin baseline did (gunship L1 started on
  // day 17 of a 28-day truce before this feature). Since level 1 is now
  // ASAP-eligible by default for every demanded unit (not just hand-pinned
  // ones), Japan's real plan has many L1 tasks genuinely competing for the same
  // 2 slots — a materially tighter contention picture than the old world where
  // only a handful of hand-curated units raced for early placement. Gunship
  // still lands early (day ~4-5) relative to the 28-day window, just not within
  // the old, contention-naive ~2-day bound.
  const gunshipL1 = byUnitLevel.get("helicopter_gunship:1");
  assert.ok(gunshipL1);
  assert.ok(
    gunshipL1!.startAbsoluteHour <= scenarioAbsHour + 168,
    `helicopter_gunship L1 should start within ~7 days of scenario start (well before the old day-17 JIT-drift baseline), got hour ${gunshipL1!.startAbsoluteHour} (scenario start ${scenarioAbsHour})`
  );

  // Being ASAP-eligible only exempts a task from carrying its OWN buffer
  // padding as level 1 (never buffered, pinned or not) — level 2+ tasks pay
  // the same 24h buffer whether they're ASAP-committed via commitAsapTier or
  // JIT-placed by the ordinary backward-fill (PR #19's explicit design
  // change: "the 24h research buffer now applies uniformly to every level 2+
  // task, ASAP-eligible or not" — it modelled a hand-pinned Iron-workaround
  // exemption that no longer reflects the real domain rule). So
  // helicopter_gunship's own chain is NOT expected to be byte-identical
  // with/without the buffer — verify instead that its own level 2+ segments
  // show the same >=24h intra-slot gap the unpinned awacs/fixed_wing_veteran
  // check below verifies, and that removing the buffer measurably tightens
  // the chain (proving the buffer is doing real work here, not incidentally
  // satisfied).
  const withoutBufferButPinned = computeCountryForceProjection({
    country, doctrine: country.country.doctrine, status: countryPlan.status,
    demands: countryPlan.demands,
    scenario, buildings, catalog,
    scenarioAbsHour, deadlineAbsHour,
    truceDays: plan.truce_days,
    maxRoLevel: 5,
    researchAsapPins: testAsapPins,
  });
  const byUnitLevelNoBuffer = new Map(withoutBufferButPinned.researchSegments.map(s => [`${s.unitId}:${s.level}`, s]));
  const gunshipL1WithBuffer = byUnitLevel.get("helicopter_gunship:1");
  const gunshipL6WithBuffer = byUnitLevel.get("helicopter_gunship:6");
  const gunshipL6NoBuffer = byUnitLevelNoBuffer.get("helicopter_gunship:6");
  assert.ok(gunshipL1WithBuffer && gunshipL6WithBuffer && gunshipL6NoBuffer);
  assert.ok(
    gunshipL6WithBuffer!.endAbsoluteHourExclusive > gunshipL6NoBuffer!.endAbsoluteHourExclusive,
    "helicopter_gunship's chain should finish later with researchBufferHours set than without it, proving the buffer is actually applied to this ASAP chain",
  );

  const gunshipSegsByLevel = new Map(
    result.researchSegments.filter(s => s.unitId === "helicopter_gunship").map(s => [s.level, s]),
  );
  const gunshipBySlot = new Map<number, typeof result.researchSegments>();
  for (const seg of gunshipSegsByLevel.values()) {
    if (!gunshipBySlot.has(seg.slot)) gunshipBySlot.set(seg.slot, []);
    gunshipBySlot.get(seg.slot)!.push(seg);
  }
  for (const segments of gunshipBySlot.values()) {
    segments.sort((a, b) => a.startAbsoluteHour - b.startAbsoluteHour);
    for (let i = 1; i < segments.length; i++) {
      // The buffer is reserved as trailing padding by the task that finishes
      // (commitAsapTier's consumedEnd), and level 1 is explicitly exempt from
      // reserving any — so a level-1 task immediately followed, in the same
      // slot, by a level 2+ task can show less than the full 24h (that gap is
      // then driven by whatever else floors the level 2+ task, e.g. its own
      // cross-slot dependency). Only a level 2+ task following another level
      // 2+ task in the same slot is guaranteed the full buffer.
      if (segments[i - 1].level === 1) continue;
      const gap = segments[i].startAbsoluteHour - segments[i - 1].endAbsoluteHourExclusive;
      assert.ok(gap >= 24, `expected >=24h buffer before helicopter_gunship L${segments[i].level}, got ${gap}h`);
    }
  }

  // awacs level 2+ and fixed_wing_veteran level 2+ are NOT pinned — they must show
  // the buffer whenever they immediately follow another segment in the same slot.
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

  // Feasible — see the Russia test's comment above for why. Independent of
  // this test's actual purpose (verifying eco-credit/RO-first behaviour below).
  assert.equal(ecoCredited.infeasible, false);
  assert.equal(ecoCredited.overrunDemands.length, 0);
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

test("computeCountryForceProjection: India's dead-window SASF cities mobilise a filler unit well before the primary unit's own readiness, using otherwise-idle mob-queue capacity", () => {
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

  // City assignment is now fully cost-driven (no preferred_cities pin), so
  // which city and which filler unit end up sharing SASF's dead window is an
  // outcome of foldInDemands, not a fixture guarantee — discover it rather
  // than hardcoding "mumbai"/"uav" from the old pinned setup.
  const sasfCity = result.citySlots.find(
    s => s.primaryUnitId === "stealth_air_superiority_fighter" &&
      new Set(s.mobQueue.map(e => e.unitId)).size > 1,
  );
  assert.ok(sasfCity, "expected at least one SASF city sharing its mob queue with a filler unit");
  const sasfStep = sasfCity!.mobSteps.find(s => s.unitId === "stealth_air_superiority_fighter");
  const fillerStep = sasfCity!.mobSteps.find(s => s.unitId !== "stealth_air_superiority_fighter");
  assert.ok(sasfStep && fillerStep);
  assert.ok(
    fillerStep!.endAbsHour <= sasfStep!.startAbsHour,
    "the filler must fully mobilise before SASF starts (queue is sequential — this only checks ordering, not the dead-window timing claim below)",
  );
  // The filler starts at its own, real readiness hour — never later than the
  // point its own required buildings actually complete. Not asserting "well
  // before air_base L5" here any more: which filler the cost-driven search
  // picks (no preferred_cities pin any more) is no longer guaranteed to be
  // one with a big head-start window like the old hand-picked uav case (uav
  // needs only air_base L1, so it could start deep inside SASF's L1-L5 climb;
  // conventional_warhead needs secret_weapons_lab, which itself requires
  // air_base L5 to build, so it has no such head-start available even though
  // it's still a genuine, correctly-detected dead-window filler). The
  // exploitable size of a dead-window benefit is a property of which units
  // happen to share a city, not something this general mechanism controls —
  // capturing the biggest such windows is exactly the "optimal city subset
  // search" gap a real joint city-selection optimizer would need to close.
  const fillerReqs = getUnitBuildingRequirements(fillerStep!.unitId, catalog, buildings);
  for (const [bldgId, lvl] of fillerReqs) {
    const step = sasfCity!.infraSteps.find(s => s.buildingId === bldgId && s.toLevel >= lvl);
    if (step) {
      assert.ok(
        fillerStep!.startAbsHour >= step.endHour,
        `filler unit (${fillerStep!.unitId}) must not start (${fillerStep!.startAbsHour}) before its own requirement ${bldgId} L${lvl} completes (${step.endHour})`,
      );
    }
  }
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

  // City assignment is cost-driven (no preferred_cities pin) — discover the
  // dead-window SASF city rather than hardcoding "mumbai" from the old pinned
  // setup.
  const sasfCity = result.citySlots.find(
    s => s.primaryUnitId === "stealth_air_superiority_fighter" &&
      new Set(s.mobQueue.map(e => e.unitId)).size > 1,
  );
  assert.ok(sasfCity, "expected at least one SASF city sharing its mob queue with a filler unit");
  const secretLabStep = sasfCity!.infraSteps.find(s => s.buildingId === "secret_weapons_lab");
  const roL2Step = sasfCity!.infraSteps.find(s => s.buildingId === "recruiting_office" && s.toLevel >= 2);
  assert.ok(secretLabStep, "fixture assumption: secret_weapons_lab is in the dead-window city's infra chain (formula-based, no eco credit in this test)");
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

// ── splitMobBatchByLevel ─────────────────────────────────────────────────────
//
// Uses real mobile_sam_launcher (eastern doctrine) mobilisation-duration data
// against synthetic levelSteps, so the boundary arithmetic is exercised with
// genuine per-level durations rather than a hand-rolled fixture unit.

function samSplitFixture() {
  const scenarioId = "elite/antarctica";
  const buildings = loadBuildingsFile();
  const catalog = loadMergedUnitCatalogForScenario(scenarioId);
  const moraleAtAbsHour = (absHour: number) => baselineHomelandMoraleOnDay(Math.floor(absHour / 24) + 1);
  return { catalog, buildings, moraleAtAbsHour, unitId: "mobile_sam_launcher", doctrine: "eastern", roLevel: 2 };
}

test("splitMobBatchByLevel: batch entirely before the first level boundary returns one phase at the starting level", () => {
  const { catalog, buildings, moraleAtAbsHour, unitId, doctrine, roLevel } = samSplitFixture();
  const levelSteps: LevelStep[] = [{ absHour: 1000, level: 2 }];

  const { phases, totalMobHours, mobEnd } = splitMobBatchByLevel({
    mobStart: 100, count: 5, unitId, levelSteps, roLevel, catalog, buildings, doctrine, moraleAtAbsHour,
  });

  assert.equal(phases.length, 1);
  assert.equal(phases[0].level, 1);
  assert.equal(phases[0].count, 5);
  assert.equal(phases[0].mobStart, 100);
  assert.equal(totalMobHours, phases[0].totalMobHours);
  assert.equal(mobEnd, phases[0].mobEnd);
});

test("splitMobBatchByLevel: batch starting after all research already completed returns one phase at the highest level", () => {
  const { catalog, buildings, moraleAtAbsHour, unitId, doctrine, roLevel } = samSplitFixture();
  const levelSteps: LevelStep[] = [{ absHour: 50, level: 2 }, { absHour: 80, level: 3 }];

  const { phases } = splitMobBatchByLevel({
    mobStart: 100, count: 4, unitId, levelSteps, roLevel, catalog, buildings, doctrine, moraleAtAbsHour,
  });

  assert.equal(phases.length, 1);
  assert.equal(phases[0].level, 3, "should start at the highest already-completed level, matching computeSteppedUpkeep's bootstrap convention");
});

test("splitMobBatchByLevel: batch straddling one boundary splits into two phases whose combined count equals the input", () => {
  const { catalog, buildings, moraleAtAbsHour, unitId, doctrine, roLevel } = samSplitFixture();
  // Boundary placed mid-batch: with real SAM eastern durations (~14-15h/unit
  // at RO2), a boundary ~60h into a 10-unit batch falls inside the window.
  const levelSteps: LevelStep[] = [{ absHour: 160, level: 2 }];

  const { phases, totalMobHours } = splitMobBatchByLevel({
    mobStart: 100, count: 10, unitId, levelSteps, roLevel, catalog, buildings, doctrine, moraleAtAbsHour,
  });

  assert.ok(phases.length >= 2, "expected the batch to straddle the boundary into at least two phases");
  assert.equal(phases[0].level, 1);
  assert.equal(phases.at(-1)!.level, 2);
  // Levels must be non-decreasing and phases contiguous (no gaps/overlaps).
  for (let i = 1; i < phases.length; i++) {
    assert.ok(phases[i].level > phases[i - 1].level, "each subsequent phase must be at a strictly higher level");
    assert.equal(phases[i].mobStart, phases[i - 1].mobEnd, "phases must be contiguous");
  }
  const summedCount = phases.reduce((s, p) => s + p.count, 0);
  assert.equal(summedCount, 10, "every unit must be accounted for exactly once across phases");
  assert.equal(totalMobHours, phases.reduce((s, p) => s + p.totalMobHours, 0));
});

test("splitMobBatchByLevel: batch straddling multiple boundaries produces one phase per level crossed, still conserving total count", () => {
  const { catalog, buildings, moraleAtAbsHour, unitId, doctrine, roLevel } = samSplitFixture();
  const levelSteps: LevelStep[] = [
    { absHour: 130, level: 2 },
    { absHour: 160, level: 3 },
    { absHour: 200, level: 4 },
  ];

  const { phases } = splitMobBatchByLevel({
    mobStart: 100, count: 20, unitId, levelSteps, roLevel, catalog, buildings, doctrine, moraleAtAbsHour,
  });

  const levelsSeen = phases.map(p => p.level);
  assert.deepEqual(levelsSeen, [...levelsSeen].sort((a, b) => a - b), "levels must appear in non-decreasing order");
  assert.deepEqual([...new Set(levelsSeen)], levelsSeen, "no level should repeat as a separate phase (must be merged) — the off-by-one this test guards against");
  assert.equal(phases.reduce((s, p) => s + p.count, 0), 20);
});

test("splitMobBatchByLevel: a boundary landing with less than one unit's worth of room still makes progress (no infinite loop)", () => {
  const { catalog, buildings, moraleAtAbsHour, unitId, doctrine, roLevel } = samSplitFixture();
  // Boundary 1 hour after mobStart — far less than one unit's own duration —
  // forces the degenerate "at least 1 unit" case for the first phase.
  const levelSteps: LevelStep[] = [{ absHour: 101, level: 2 }];

  const { phases } = splitMobBatchByLevel({
    mobStart: 100, count: 3, unitId, levelSteps, roLevel, catalog, buildings, doctrine, moraleAtAbsHour,
  });

  assert.equal(phases.reduce((s, p) => s + p.count, 0), 3);
  assert.ok(phases.length <= 3, "must terminate, not loop indefinitely");
});

// ── computeCountryForceProjection: Russia's real mobile_sam_launcher demand ──

test("computeCountryForceProjection: Russia's mobile_sam_launcher mob steps are split across multiple research levels, priced above the old flat-L1 total", () => {
  const scenarioId = "elite/antarctica";
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const catalog = loadMergedUnitCatalogForScenario(scenarioId);
  const plan = loadScenarioCoalitionPlan(scenarioId, "pnth-v-iron-2026-aug");
  const country = loadScenarioCountry(scenarioId, "russia");
  const countryPlan = plan.countries.russia;
  const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
  const deadlineAbsHour = scenarioAbsHour + plan.truce_days * 24;

  const samDemand = countryPlan.demands.find(d => d.unitId === "mobile_sam_launcher");
  assert.ok(samDemand, "fixture assumption: Russia's plan still demands mobile_sam_launcher");

  const result = computeCountryForceProjection({
    country, doctrine: country.country.doctrine, status: countryPlan.status,
    demands: countryPlan.demands,
    scenario, buildings, catalog,
    scenarioAbsHour, deadlineAbsHour,
    truceDays: plan.truce_days,
    maxRoLevel: 5,
  });

  const samSteps = result.citySlots.flatMap(s => s.mobSteps.filter(m => m.unitId === "mobile_sam_launcher"));
  assert.ok(samSteps.length > 0, "fixture assumption: at least one city mobilises mobile_sam_launcher");

  const levelsUsed = new Set(samSteps.map(m => m.level ?? 1));
  assert.ok(levelsUsed.size > 1, "the batch should straddle multiple research levels, not price everything at a single flat level");

  const totalCount = samSteps.reduce((s, m) => s + m.count, 0);
  assert.equal(totalCount, samDemand!.count, "every demanded unit must appear exactly once across mob steps");

  // Regression guard against the fix silently no-op'ing: the corrected,
  // per-level-split total mobilisation cost must exceed what pricing the
  // entire batch at a flat level 1 would have produced.
  let splitCost = 0;
  let flatL1Cost = 0;
  for (const m of samSteps) {
    const level = m.level ?? 1;
    splitCost += resourceCostToScalar(calculateMobilizationCost("mobile_sam_launcher", level, m.count, catalog, country.country.doctrine));
    flatL1Cost += resourceCostToScalar(calculateMobilizationCost("mobile_sam_launcher", 1, m.count, catalog, country.country.doctrine));
  }
  assert.ok(splitCost >= flatL1Cost, `expected corrected mob cost (${splitCost}) to be >= the old flat-L1 total (${flatL1Cost})`);
});

test("computeCountryForceProjection: Japan's unit_limit-gated elite_attack_helicopter tranches never emit two consecutive mob steps at the same level (the ceil-vs-floor boundary fix)", () => {
  const scenarioId = "elite/antarctica";
  const scenario = loadScenarioFile(scenarioId);
  const buildings = loadBuildingsFile();
  const catalog = loadMergedUnitCatalogForScenario(scenarioId);
  const plan = loadScenarioCoalitionPlan(scenarioId, "pnth-v-iron-2026-aug");
  const country = loadScenarioCountry(scenarioId, "japan");
  const countryPlan = plan.countries.japan;
  const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
  const deadlineAbsHour = scenarioAbsHour + plan.truce_days * 24;

  const eahDemand = countryPlan.demands.find(d => d.unitId === "elite_attack_helicopter");
  assert.ok(eahDemand, "fixture assumption: Japan's plan still demands elite_attack_helicopter");

  const result = computeCountryForceProjection({
    country, doctrine: country.country.doctrine, status: countryPlan.status,
    demands: countryPlan.demands,
    scenario, buildings, catalog,
    scenarioAbsHour, deadlineAbsHour,
    truceDays: plan.truce_days,
    maxRoLevel: 5,
    researchBufferHours: plan.research_buffer_hours,
  });

  let sawAnySteps = false;
  let totalCount = 0;
  for (const slot of result.citySlots) {
    const stepsInCity = slot.mobSteps
      .filter(m => m.unitId === "elite_attack_helicopter")
      .sort((a, b) => a.startAbsHour - b.startAbsHour);
    if (stepsInCity.length === 0) continue;
    sawAnySteps = true;
    for (let i = 1; i < stepsInCity.length; i++) {
      assert.notEqual(
        stepsInCity[i].level, stepsInCity[i - 1].level,
        `consecutive mob steps in ${slot.cityId} at the same level (${stepsInCity[i].level}) should have been merged into one — off-by-one boundary bug`,
      );
      // Unlike splitMobBatchByLevel's phases WITHIN one tranche (always
      // contiguous by construction), separate unit_limit TRANCHES can have a
      // legitimate idle gap between them — a later tranche's mobStart is
      // floored at its OWN unit_limit-gating research level's completion,
      // which can fall later than when the previous tranche actually finished.
      assert.ok(stepsInCity[i].startAbsHour >= stepsInCity[i - 1].endAbsHour, `mob steps for the same unit in ${slot.cityId} must not overlap`);
    }
    totalCount += stepsInCity.reduce((s, m) => s + m.count, 0);
  }
  assert.ok(sawAnySteps, "fixture assumption: at least one city mobilises elite_attack_helicopter");
  assert.equal(totalCount, eahDemand!.count, "every demanded unit must appear exactly once across mob steps");
});
