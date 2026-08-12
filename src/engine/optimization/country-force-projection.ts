import type { BuildingsFile } from "../../schemas/building-schema.js";
import type { Country } from "../../schemas/country-schema.js";
import type { ScenarioFile } from "../../schemas/scenario-schema.js";
import type { UnitCatalog } from "../../schemas/unit-schema.js";
import type { Demand } from "../../schemas/coalition-force-plan-schema.js";
import { durationToHours } from "../timing/activity-duration.js";
import {
  calculateMobilizationCost,
  calculateUpkeepCost,
  calculateBuildingCost,
  sumResourceCosts,
} from "./cost-calculator.js";
import type { ResourceCost } from "./types.js";
import { simulateUnitResearchTargets, determineMaximumFeasibleLevel } from "../simulation/unit-research-sim.js";
import type { UnitResearchSegment } from "../simulation/unit-research-sim.js";
import { planProvinceMobilization } from "../simulation/province-mobilization-plan.js";
import type { ProvinceMobilizationPlan } from "../simulation/province-mobilization-plan.js";
import { baselineHomelandMoraleOnDay } from "../economy/morale.js";
import { computeFlipPoint } from "../eco/flip-point-solver.js";
import type { CityEcoResult } from "../eco/city-eco-beam.js";
import {
  computePlanWeights,
  foldInDemands,
  type CityMobSlot,
  type MobQueueEntry,
  type MoraleAtHour,
  type PlanWeights,
} from "./joint-city-optimizer.js";

// ── Domain helpers (moved from harness/smoke/force-projection.ts, unchanged logic) ──

/**
 * Whether the catalog has any mobilisation data at all for this unit+doctrine.
 * Distinct from "genuinely zero mob time" (a real launcher platform) — this is
 * "we don't know the mob time because the doctrine data is missing" (a data gap).
 * Conflating the two used to make classifyDemands silently drop units with missing
 * doctrine data (misclassifying them as launcher platforms) instead of surfacing
 * the gap.
 */
function hasMobilisationData(unitId: string, doctrine: string, catalog: UnitCatalog): boolean {
  return !!catalog.units[unitId]?.levels?.["1"]?.mobilisation?.[doctrine];
}

function unitMobTimeHours(unitId: string, doctrine: string, catalog: UnitCatalog): number {
  const level1 = catalog.units[unitId]?.levels?.["1"];
  const mobData = level1?.mobilisation?.[doctrine];
  if (!mobData) return 0;
  return durationToHours(mobData.time);
}

export function getBatchSize(unitId: string, catalog: UnitCatalog): number {
  return (
    (catalog.units[unitId]?.levels?.["1"] as { batch_size?: number } | undefined)?.batch_size ?? 1
  );
}

/**
 * Returns the building requirements for L1 mobilisation of a unit
 * (buildings only — units are excluded).
 */
function getUnitBuildingRequirements(unitId: string, catalog: UnitCatalog, buildings: BuildingsFile): Map<string, number> {
  const unit = catalog.units[unitId];
  const required = new Map<string, number>();
  if (!unit) return required;
  const level1 = unit.levels["1"];
  if (!level1) return required;
  for (const req of level1.requirements) {
    const match = req.trim().match(/^(.+?)\s+level\s+(\d+)$/i);
    if (!match) continue;
    const id = match[1].trim();
    const lvl = Number(match[2]);
    if (!catalog.units[id] && buildings.buildings[id]) {
      required.set(id, Math.max(required.get(id) ?? 0, lvl));
    }
  }
  return required;
}

function buildingRequirementsCost(unitId: string, cityCount: number, catalog: UnitCatalog, buildings: BuildingsFile): ResourceCost {
  const reqs = getUnitBuildingRequirements(unitId, catalog, buildings);
  let total: ResourceCost = {};
  for (const [buildingId, requiredLevel] of reqs) {
    if (buildingId === "recruiting_office") continue; // RO cost is tracked via the config generator sweep, not double-counted here
    const perCity = calculateBuildingCost(buildingId, 0, requiredLevel, buildings);
    for (let i = 0; i < cityCount; i++) total = sumResourceCosts(total, perCity);
  }
  return total;
}

export type ClassifiedDemands = {
  provinceDemands: Demand[];
  launcherDemands: Demand[];
  activeDemands: Demand[];
  /** Units with NO mobilisation data at all for this country's doctrine — a
   *  catalog data gap, not a real demand classification. Excluded from every
   *  other bucket so they're never silently costed as zero. */
  missingDataDemands: Demand[];
};

/**
 * Splits demands into province-mobilised, launcher-platform (genuinely zero mob
 * time), active (city-mobilised), and missing-doctrine-data buckets. Exported so
 * callers (e.g. the resource-projection harness) can compute `activeDemands` for
 * `computePlanWeights` before Unit 2 runs.
 */
export function classifyDemands(demands: Demand[], doctrine: string, catalog: UnitCatalog): ClassifiedDemands {
  const provinceDemands: Demand[] = [];
  const launcherDemands: Demand[] = [];
  const activeDemands: Demand[] = [];
  const missingDataDemands: Demand[] = [];

  for (const demand of demands) {
    if (demand.mobilisation_source === "province") {
      provinceDemands.push(demand);
    } else if (!hasMobilisationData(demand.unitId, doctrine, catalog)) {
      missingDataDemands.push(demand);
    } else if (unitMobTimeHours(demand.unitId, doctrine, catalog) === 0) {
      launcherDemands.push(demand);
    } else {
      activeDemands.push(demand);
    }
  }

  return { provinceDemands, launcherDemands, activeDemands, missingDataDemands };
}

export type InfraStep = { name: string; startHour: number; endHour: number; durH: number; cost: ResourceCost };

/**
 * Building build order for a city's infra chain: recruiting_office is mandatory
 * first (cheap, and needed for its manpower bonus from day 1 — settled UAT rule),
 * everything else sorted descending by eco benefit score.
 *   production_bonus_pct applies to all resources → scale by total weight (all resources benefit)
 *   manpower_bonus_pct applies to manpower only → scale by manpower weight
 *   flat_bonus.manpower is a fixed hourly bonus → scale by manpower weight (normalised per 1000h)
 *   buildings with no income bonus score 0 and sort last
 */
function makeInfraOrderBuildings(weights: PlanWeights, buildings: BuildingsFile): (ids: string[]) => string[] {
  function ecoScore(buildingId: string): number {
    const l1 = buildings.buildings[buildingId]?.levels["1"];
    if (!l1) return 0;
    const totalWeight = (Object.values(weights) as number[]).reduce((s, w) => s + w, 0);
    const mpWeight = weights.manpower ?? 0;
    return (l1.production_bonus_pct ?? 0) * totalWeight
      + (l1.manpower_bonus_pct ?? 0) * mpWeight
      + (l1.flat_bonus?.manpower ?? 0) * mpWeight / 1000;
  }
  return (ids: string[]) => [
    ...ids.filter(id => id === "recruiting_office"),
    ...ids.filter(id => id !== "recruiting_office").sort((a, b) => ecoScore(b) - ecoScore(a)),
  ];
}

function requiredLevelsForUnit(unitId: string, roLevel: number, catalog: UnitCatalog, buildings: BuildingsFile): Record<string, number> {
  const reqs = getUnitBuildingRequirements(unitId, catalog, buildings);
  const allReqs = new Map(reqs);
  if (roLevel > 0) allReqs.set("recruiting_office", roLevel);
  return Object.fromEntries(allReqs);
}

/** Formula-based infra chain: builds every required level from scratch, starting at `startHour`. */
function buildCityInfraSteps(
  unitId: string,
  roLevel: number,
  startHour: number,
  weights: PlanWeights,
  catalog: UnitCatalog,
  buildings: BuildingsFile,
): { steps: InfraStep[]; mobOpenHour: number } {
  const steps: InfraStep[] = [];
  let cur = startHour;

  const requiredLevels = requiredLevelsForUnit(unitId, roLevel, catalog, buildings);
  const orderBuildings = makeInfraOrderBuildings(weights, buildings);
  const orderedIds = orderBuildings(Object.keys(requiredLevels));

  for (const bldgId of orderedIds) {
    const targetLvl = requiredLevels[bldgId];
    const bldg = buildings.buildings[bldgId];
    if (!bldg) continue;
    for (let lvl = 1; lvl <= targetLvl; lvl++) {
      const levelData = bldg.levels[String(lvl) as keyof typeof bldg.levels];
      const bt = (levelData as { build_time?: { days?: number; hours?: number; minutes?: number } } | undefined)?.build_time;
      if (!bt) continue;
      const dur = Math.ceil(durationToHours(bt));
      const cost = calculateBuildingCost(bldgId, lvl - 1, lvl, buildings);
      steps.push({ name: `${bldgId.replaceAll("_", " ")} L${lvl}`, startHour: cur, endHour: cur + dur, durH: dur, cost });
      cur += dur;
    }
  }

  return { steps, mobOpenHour: cur };
}

/**
 * Eco-aware infra chain: credits building levels the city's Unit 1.5 "actual eco
 * build" already completed, and iteratively re-derives the flip point (via
 * `computeFlipPoint`'s convergence loop, repurposed with `mobilisationWindowHours: 0`
 * and `deadlineAbsHour: firstMobStart` to solve "latest flip such that flip +
 * eco-credited-remaining-chain = firstMobStart"). Fixes the double-build bug where
 * the formula-based path above rebuilds buildings the eco phase already built.
 */
function buildCityInfraStepsFromEco(
  unitId: string,
  roLevel: number,
  firstMobStart: number,
  scenarioAbsHour: number,
  weights: PlanWeights,
  catalog: UnitCatalog,
  buildings: BuildingsFile,
  ecoResult: CityEcoResult,
): { steps: InfraStep[]; mobOpenHour: number; flipPointAbsHour: number } {
  const requiredLevels = requiredLevelsForUnit(unitId, roLevel, catalog, buildings);
  const orderBuildings = makeInfraOrderBuildings(weights, buildings);

  const result = computeFlipPoint(ecoResult, requiredLevels, 0, firstMobStart, scenarioAbsHour, buildings, 4, orderBuildings);
  const flipPointAbsHour = Math.max(scenarioAbsHour, result.flipPointAbsHour);

  const steps: InfraStep[] = [];
  let cur = flipPointAbsHour;
  for (const step of result.remainingChain) {
    const cost = calculateBuildingCost(step.buildingId, step.fromLevel, step.toLevel, buildings);
    steps.push({ name: `${step.buildingId.replaceAll("_", " ")} L${step.toLevel}`, startHour: cur, endHour: cur + step.buildTimeHours, durH: step.buildTimeHours, cost });
    cur += step.buildTimeHours;
  }

  return { steps, mobOpenHour: cur, flipPointAbsHour };
}

// ── Stepped upkeep helpers ────────────────────────────────────────────────

type LevelStep = { absHour: number; level: number };

function getLevelSteps(
  unitId: string,
  segments: Array<{ unitId: string; level: number; endAbsoluteHourExclusive: number }>,
): LevelStep[] {
  return segments
    .filter(s => s.unitId === unitId)
    .map(s => ({ absHour: s.endAbsoluteHourExclusive, level: s.level }))
    .sort((a, b) => a.absHour - b.absHour);
}

/**
 * Computes stepped upkeep for a mob batch.
 * Units auto-upgrade as research levels complete; upkeep steps up accordingly.
 * @param totalUnits  total units produced (entry.count × batchSize)
 * @param unitsPerEvent  units added per mob event (batchSize; 1 for non-batch)
 * @param tPerEvent  time per mob event (entry.tPerUnit)
 */
function computeSteppedUpkeep(
  unitId: string,
  doctrine: string,
  mobStart: number,
  totalUnits: number,
  unitsPerEvent: number,
  tPerEvent: number,
  deadline: number,
  levelSteps: LevelStep[],
  catalog: UnitCatalog,
): ResourceCost {
  if (totalUnits <= 0 || tPerEvent <= 0) return {};

  const numEvents = Math.ceil(totalUnits / unitsPerEvent);
  const eventSet = new Set<number>([deadline]);
  for (let k = 1; k <= numEvents; k++) {
    const t = mobStart + k * tPerEvent;
    if (t < deadline) eventSet.add(t);
  }
  for (const step of levelSteps) {
    if (step.absHour > mobStart && step.absHour < deadline) eventSet.add(step.absHour);
  }
  const events = [...eventSet].sort((a, b) => a - b);

  // Highest research level completed at or before mobStart
  let level = 1;
  for (const step of levelSteps) {
    if (step.absHour <= mobStart && step.level > level) level = step.level;
  }
  const levelAtEvent = new Map<number, number>();
  for (const step of levelSteps) {
    const prev = levelAtEvent.get(step.absHour) ?? 0;
    if (step.level > prev) levelAtEvent.set(step.absHour, step.level);
  }

  let total: ResourceCost = {};
  let prevT = mobStart;

  for (const t of events) {
    const dt = t - prevT;
    if (dt > 0) {
      // countAlive = units that have completed mob by prevT
      const eventsCompleted = Math.min(numEvents, Math.floor((prevT - mobStart) / tPerEvent));
      const countAlive = eventsCompleted * unitsPerEvent;
      if (countAlive > 0) {
        try {
          total = sumResourceCosts(total, calculateUpkeepCost(unitId, level, countAlive, dt, catalog, doctrine));
        } catch {
          // missing doctrine/level data — skip interval
        }
      }
    }
    const newLevel = levelAtEvent.get(t);
    if (newLevel !== undefined && newLevel > level) level = newLevel;
    prevT = t;
  }

  return total;
}

// ── Public types ──────────────────────────────────────────────────────────

export type CityForceProjectionSlot = {
  cityId: string;
  roLevel: number;
  primaryUnitId: string;
  mobQueue: MobQueueEntry[];
  infraOpenHour: number;
  /** The real, research-aware flip point: latest hour this city can still run
   *  eco builds before switching to military infra to hit the deadline. */
  flipPointAbsHour: number;
  infraSteps: InfraStep[];
  mobSteps: Array<{ unitId: string; count: number; startAbsHour: number; endAbsHour: number; durationHours: number }>;
};

export type CountryForceProjectionInput = {
  country: Country;
  doctrine: string;
  status: "homeland" | "occupied";
  demands: Demand[];
  scenario: ScenarioFile;
  buildings: BuildingsFile;
  catalog: UnitCatalog;
  scenarioAbsHour: number;
  deadlineAbsHour: number;
  truceDays: number;
  maxRoLevel: number;
  /** Pre-computed plan weights (e.g. shared with Unit 1.5's actual eco build). When
   *  provided, skips the internal computePlanWeights call to avoid two independent
   *  computations of "the same" weights drifting apart. */
  planWeights?: PlanWeights;
  /** Unit 1.5 "actual eco build" results, keyed by bare cityId. When a city has an
   *  entry, its infra chain is eco-credited (buildCityInfraStepsFromEco) instead of
   *  built from scratch — fixes the double-build bug. Cities without an entry (or
   *  when the whole map is absent) fall back to the formula-based chain. */
  actualEcoResultsByCity?: Map<string, CityEcoResult>;
};

export type CountryForceProjectionResult = {
  countryName: string;
  moraleAtStart: number;
  moraleAtDeadline: number;
  researchSegments: UnitResearchSegment[];
  citySlots: CityForceProjectionSlot[];
  costs: {
    infraRo: ResourceCost;
    infraBuildings: ResourceCost;
    mobilisation: ResourceCost;
    upkeep: ResourceCost;
    provinceMobilisation: ResourceCost;
    provinceUpkeep: ResourceCost;
    total: ResourceCost;
  };
  provinceMobResults: ProvinceMobilizationPlan[];
  demandLabels: string[];
  skippedDemands: Demand[];
  /** Units with NO mobilisation data at all for this country's doctrine — a
   *  catalog data gap. Distinct from skippedDemands (genuine zero-mob-cost
   *  launcher platforms) — these are silently-would-be-wrong if not surfaced. */
  missingDataDemands: Demand[];
  infeasible: boolean;
  /** Set only on early-exit (no demands / no city-mobilised demands); citySlots etc. are empty. */
  reason?: "no_demands" | "no_active_demands";
  /** Resource weights actually used (either input.planWeights, or computed internally). */
  planWeights: PlanWeights;
};

// ── Main entry point ─────────────────────────────────────────────────────

export function computeCountryForceProjection(input: CountryForceProjectionInput): CountryForceProjectionResult {
  const {
    country, doctrine, status, demands, scenario, buildings, catalog,
    scenarioAbsHour, deadlineAbsHour, truceDays, maxRoLevel,
    planWeights: inputPlanWeights, actualEcoResultsByCity,
  } = input;

  const countryName = country.country.name;
  const isOccupied = status === "occupied";
  const moraleAtAbsHour: MoraleAtHour = (absHour) => {
    const day = Math.floor(absHour / 24) + 1;
    // TODO: use captured morale curve when an occupied morale function is available
    return isOccupied ? 50 : baselineHomelandMoraleOnDay(day);
  };

  const emptyCosts = { infraRo: {}, infraBuildings: {}, mobilisation: {}, upkeep: {}, provinceMobilisation: {}, provinceUpkeep: {}, total: {} };

  if (demands.length === 0) {
    return {
      countryName,
      moraleAtStart: moraleAtAbsHour(scenarioAbsHour),
      moraleAtDeadline: moraleAtAbsHour(deadlineAbsHour),
      researchSegments: [],
      citySlots: [],
      costs: emptyCosts,
      provinceMobResults: [],
      demandLabels: [],
      skippedDemands: [],
      missingDataDemands: [],
      infeasible: true,
      reason: "no_demands",
      planWeights: inputPlanWeights ?? {},
    };
  }

  const { provinceDemands, launcherDemands, activeDemands, missingDataDemands } = classifyDemands(demands, doctrine, catalog);

  if (activeDemands.length === 0) {
    return {
      countryName,
      moraleAtStart: moraleAtAbsHour(scenarioAbsHour),
      moraleAtDeadline: moraleAtAbsHour(deadlineAbsHour),
      researchSegments: [],
      citySlots: [],
      costs: emptyCosts,
      provinceMobResults: [],
      demandLabels: [],
      skippedDemands: launcherDemands,
      missingDataDemands,
      infeasible: true,
      reason: "no_active_demands",
      planWeights: inputPlanWeights ?? {},
    };
  }

  type DemandResult = { demand: Demand; batchSize: number; effectiveCount: number };
  const demandResults: DemandResult[] = activeDemands.map(demand => {
    const batchSize = getBatchSize(demand.unitId, catalog);
    return { demand, batchSize, effectiveCount: Math.ceil(demand.count / batchSize) };
  });

  // ── Joint demand optimization — fold-in algorithm ─────────────────────────
  const countryAllCityIds = country.cities.map(c => c.id);

  const planWeights: PlanWeights = inputPlanWeights ?? computePlanWeights(
    activeDemands.map(d => ({
      unitId: d.unitId,
      effectiveCount: Math.ceil(d.count / getBatchSize(d.unitId, catalog)),
    })),
    catalog,
    doctrine,
    truceDays,
  );

  const foldResult = foldInDemands(
    activeDemands.map(d => ({
      unitId: d.unitId,
      effectiveCount: Math.ceil(d.count / getBatchSize(d.unitId, catalog)),
    })),
    countryAllCityIds,
    catalog,
    buildings,
    doctrine,
    scenarioAbsHour,
    deadlineAbsHour,
    planWeights,
    maxRoLevel,
    moraleAtAbsHour,
  );

  // ── Combined JIT research plan (L1 constraints from fold-in mob schedule) ──
  const researchTargets: Record<string, number> = {};
  const latestCompletionByUnitLevel: Record<string, number> = {};
  const unitDemandCounts: Record<string, number> = {};

  for (const { demand, effectiveCount } of demandResults) {
    const uid = demand.unitId;
    unitDemandCounts[uid] = effectiveCount;
    researchTargets[uid] = determineMaximumFeasibleLevel(
      catalog, uid,
      { ...scenario, truce_length_days: truceDays },
      { deadlineAbsoluteHour: deadlineAbsHour, doctrine, slots: 1 },
    ).maxLevel;
  }

  // For each city slot, derive the JIT mob start for each entry and update
  // the L1 constraint: L1 must complete before its mob window opens.
  for (const slot of foldResult.citySlots) {
    let cumBefore = 0;
    for (const entry of slot.mobQueue) {
      const totalFromHere = slot.usedHours - cumBefore;
      const jitMobStart = deadlineAbsHour - totalFromHere;
      const actualMobStart = Math.max(slot.infraOpenHour + cumBefore, jitMobStart);
      const key = `${entry.unitId}:1`;
      const cur = latestCompletionByUnitLevel[key] ?? Infinity;
      if (actualMobStart < cur) latestCompletionByUnitLevel[key] = actualMobStart;
      cumBefore += entry.totalMobHours;
    }
  }

  const combinedResearch = simulateUnitResearchTargets(
    catalog,
    researchTargets,
    { ...scenario, truce_length_days: truceDays },
    { enableJitScheduling: true, doctrine, latestCompletionByUnitLevel, unitDemandCounts },
  );

  // ── Per-city flip point, infra steps, mob steps ───────────────────────────
  const citySlots: CityForceProjectionSlot[] = foldResult.citySlots.map((slot: CityMobSlot) => {
    const primaryUnitId = slot.primaryUnitId;

    const firstEntry = slot.mobQueue[0];
    const firstJitMobStart = deadlineAbsHour - slot.usedHours;
    const firstL1EndForJit = combinedResearch.segments.find(
      s => s.unitId === firstEntry?.unitId && s.level === 1,
    )?.endAbsoluteHourExclusive ?? deadlineAbsHour;
    const firstMobStart = Math.max(slot.infraOpenHour, firstJitMobStart, firstL1EndForJit);

    const ecoResult = actualEcoResultsByCity?.get(slot.cityId);

    let flipPointAbsHour: number;
    let infraSteps: InfraStep[];
    let infraDoneHour: number;

    if (ecoResult) {
      // Eco-credited path: skips levels the Unit 1.5 actual eco build already
      // completed and iteratively re-derives the flip point accordingly — fixes
      // the double-build bug and captures more eco income when the eco phase got
      // a head start.
      const built = buildCityInfraStepsFromEco(
        primaryUnitId, slot.roLevel, firstMobStart, scenarioAbsHour, planWeights, catalog, buildings, ecoResult,
      );
      flipPointAbsHour = built.flipPointAbsHour;
      infraSteps = built.steps;
      infraDoneHour = built.mobOpenHour;
    } else {
      // Formula-based fallback (no Unit 1.5 result for this city): the real flip
      // point is the latest hour this city can still be running eco builds before
      // it must switch to military infra to hit the deadline. (slot.flipPointHour
      // is a simpler, research-unaware version of the same idea — this one
      // additionally accounts for L1 research completion timing.)
      const infraBuildHours = slot.infraOpenHour - scenarioAbsHour;
      flipPointAbsHour = Math.max(scenarioAbsHour, firstMobStart - infraBuildHours);
      const built = buildCityInfraSteps(primaryUnitId, slot.roLevel, flipPointAbsHour, planWeights, catalog, buildings);
      infraSteps = built.steps;
      infraDoneHour = built.mobOpenHour;
    }

    const mobSteps: CityForceProjectionSlot["mobSteps"] = [];
    let cumBefore = 0;
    for (const entry of slot.mobQueue) {
      const totalFromHere = slot.usedHours - cumBefore;
      const jitMobStart = deadlineAbsHour - totalFromHere;
      const l1End = combinedResearch.segments.find(
        s => s.unitId === entry.unitId && s.level === 1,
      )?.endAbsoluteHourExclusive ?? deadlineAbsHour;
      const mobStart = Math.max(infraDoneHour + cumBefore, jitMobStart, l1End);
      const mobEnd = mobStart + entry.totalMobHours;

      mobSteps.push({
        unitId: entry.unitId,
        count: entry.count,
        startAbsHour: mobStart,
        endAbsHour: mobEnd,
        durationHours: entry.totalMobHours,
      });
      cumBefore += entry.totalMobHours;
    }

    return {
      cityId: slot.cityId,
      roLevel: slot.roLevel,
      primaryUnitId,
      mobQueue: slot.mobQueue,
      infraOpenHour: slot.infraOpenHour,
      flipPointAbsHour,
      infraSteps,
      mobSteps,
    };
  });

  // ── Mobilisation Cost Summary — aggregate across all demands ─────────────
  const demandLabels = demandResults.map(({ demand, batchSize, effectiveCount }) => {
    const batchNote = batchSize > 1 ? ` (${effectiveCount} mob events)` : "";
    return `${demand.unitId.replaceAll("_", " ")} ×${demand.count}${batchNote}`;
  });

  let aggInfraRo: ResourceCost = {};
  let aggInfraBldg: ResourceCost = {};
  let aggMob: ResourceCost = {};
  let aggUpkeep: ResourceCost = {};

  for (const { demand, batchSize } of demandResults) {
    const uid = demand.unitId;
    const mySlots = foldResult.citySlots.filter(s => s.mobQueue.some(e => e.unitId === uid));
    if (mySlots.length === 0) continue;

    // Infra: primary slots only
    for (const slot of mySlots) {
      if (slot.primaryUnitId !== uid) continue;
      aggInfraRo = sumResourceCosts(aggInfraRo, calculateBuildingCost("recruiting_office", 0, slot.roLevel, buildings));
      aggInfraBldg = sumResourceCosts(aggInfraBldg, buildingRequirementsCost(uid, 1, catalog, buildings));
    }

    // Mob cost (at L1; entry.count = mob events)
    const totalMobEvents = mySlots.reduce((s, slot) => {
      const e = slot.mobQueue.find(e => e.unitId === uid);
      return s + (e?.count ?? 0);
    }, 0);
    aggMob = sumResourceCosts(aggMob, calculateMobilizationCost(uid, 1, totalMobEvents, catalog, doctrine));

    // Stepped upkeep
    const levelSteps = getLevelSteps(uid, combinedResearch.segments);
    for (const slot of mySlots) {
      let cumBefore = 0;
      for (const entry of slot.mobQueue) {
        const totalFromHere = slot.usedHours - cumBefore;
        const jitMobStart = deadlineAbsHour - totalFromHere;
        const l1End = combinedResearch.segments.find(
          s => s.unitId === entry.unitId && s.level === 1,
        )?.endAbsoluteHourExclusive ?? deadlineAbsHour;
        const mobStart = Math.max(slot.infraOpenHour + cumBefore, jitMobStart, l1End);

        if (entry.unitId === uid) {
          aggUpkeep = sumResourceCosts(aggUpkeep, computeSteppedUpkeep(
            uid, doctrine, mobStart,
            entry.count * batchSize,  // total alive units
            batchSize,                 // units per mob event
            entry.tPerUnit,
            deadlineAbsHour,
            levelSteps,
            catalog,
          ));
        }
        cumBefore += entry.totalMobHours;
      }
    }
  }

  // ── Province-mobilised demands (commando etc.) ────────────────────────────
  // Capacity is one mobilisation slot per province; mercenary_outpost can only
  // be built in a province (never a city) and its speed bonus applies country-
  // wide once built in any single one. Mobilisation starts ASAP (hour 0) since
  // there's no eco/infra dependency gating it.
  const provinceMobResults = provinceDemands.map(demand => planProvinceMobilization({
    unitId: demand.unitId,
    level: 1,
    count: demand.count,
    provinceCount: country.provinces.total,
    unitCatalog: catalog,
    buildings,
    doctrine,
  }));
  let aggProvinceMob: ResourceCost = {};
  let aggProvinceUpkeep: ResourceCost = {};
  for (const result of provinceMobResults) {
    aggProvinceMob = sumResourceCosts(aggProvinceMob, result.totalCost);
    const remainingHours = deadlineAbsHour - (scenarioAbsHour + result.completionHour);
    if (remainingHours > 0) {
      aggProvinceUpkeep = sumResourceCosts(
        aggProvinceUpkeep,
        calculateUpkeepCost(result.unitId, result.level, result.count, remainingHours, catalog, doctrine)
      );
    }
  }

  const infeasible = foldResult.citySlots.length === 0 && provinceMobResults.length === 0;
  const aggTotal = sumResourceCosts(aggInfraRo, aggInfraBldg, aggMob, aggUpkeep, aggProvinceMob, aggProvinceUpkeep);

  return {
    countryName,
    moraleAtStart: moraleAtAbsHour(scenarioAbsHour),
    moraleAtDeadline: moraleAtAbsHour(deadlineAbsHour),
    researchSegments: combinedResearch.segments,
    citySlots,
    costs: {
      infraRo: aggInfraRo,
      infraBuildings: aggInfraBldg,
      mobilisation: aggMob,
      upkeep: aggUpkeep,
      provinceMobilisation: aggProvinceMob,
      provinceUpkeep: aggProvinceUpkeep,
      total: aggTotal,
    },
    provinceMobResults,
    demandLabels,
    skippedDemands: launcherDemands,
    missingDataDemands,
    infeasible,
    planWeights,
  };
}
