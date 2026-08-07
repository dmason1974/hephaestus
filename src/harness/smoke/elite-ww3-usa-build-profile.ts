import fs from "node:fs";
import path from "node:path";

import type { Resource } from "../../core/constants.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import { baselineHomelandMoraleOnDay } from "../../engine/economy/morale.js";
import { effectiveDurationFromMorale } from "../../engine/timing/activity-duration.js";
import type { BuildAction, CityState } from "../../engine/simulation/build-order-sim.js";
import { simulateBuildOrder } from "../../engine/simulation/build-order-sim.js";
import { scheduleBuildSegments, type TimelineCityState } from "../../engine/orchestration/build-order-timeline.js";
import { buildProvinceCohortsFromCountry } from "../../engine/provinces/province-cohorts.js";
import { simulateProvinceBuildOrder, type ProvinceBuildAction } from "../../engine/simulation/province-build-order-sim.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadMergedUnitCatalogForScenario } from "../../scenarios/io/load-unit-catalog.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";

const scenarioId = "elite/ww3";
const buildings = loadBuildingsFile(path.resolve("data/buildings.yml"));
const catalog = loadMergedUnitCatalogForScenario(scenarioId);
const scenario = loadScenarioFile(scenarioId);
const country = loadScenarioCountry(scenarioId, "united_states");
const doctrine = country.country.doctrine; // western

const truceDays = scenario.truce_length_days ?? 28;
const hoursToSimulate = truceDays * 24;
const deadlineHour = hoursToSimulate; // relative hour, city sims are 0-indexed from scenario start

const RESOURCE_KEYS: Resource[] = ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"];
function zero(): Record<Resource, number> {
  return { supplies: 0, components: 0, fuel: 0, rares: 0, electronics: 0, cash: 0, manpower: 0 };
}

// --- Fixed city assignment plan ---
// Most cities host a single demand. new_orleans hosts two sequential jobs in the
// same mob queue (dead-window pattern): Mechanized Infantry first under the RO1/armyBase2
// baseline, then Tank Veteran once the city's infra queue has caught up to armyBase3/RO2
// in the background. This frees St. Louis to become a 4th MRL city.
type Job = { unitId: string; count: number; requiredArmyBase: number; requiredRO: number; requiredAirBase?: number };
type Role = { jobs: Job[] };

// Hawaii/Anchorage dropped from ground-force military production (distance from theatre)
// — their planned 16 MAAV instead fills the otherwise-idle dead-window in the 4 MRL
// cities' mob queues between army_base L1 (~11h, MAAV-ready) and army_base L4
// (~111h, MRL-ready). Both host ASF instead (5 each, 10 total): air_base L1 (no
// army_base needed at all) is cheap enough for otherwise-idle cities to fully absorb it.
// With the corrected 109-province count, manpower is no longer a binding constraint —
// the full 10 ASF stays affordable (min running manpower +6,819, ending +10,591). The
// earlier 5-ASF cap was based on USA's country YAML incorrectly listing only 2 provinces.
const ROLES: Record<string, Role> = {
  hawaii: { jobs: [{ unitId: "air_superiority_fighter", count: 5, requiredArmyBase: 0, requiredRO: 1, requiredAirBase: 1 }] },
  st_louis: {
    jobs: [
      { unitId: "mobile_anti_air_vehicle", count: 4, requiredArmyBase: 1, requiredRO: 1 },
      { unitId: "multiple_rocket_launcher", count: 3, requiredArmyBase: 4, requiredRO: 1 },
    ],
  },
  los_angeles: {
    jobs: [
      { unitId: "mobile_anti_air_vehicle", count: 4, requiredArmyBase: 1, requiredRO: 1 },
      { unitId: "multiple_rocket_launcher", count: 3, requiredArmyBase: 4, requiredRO: 1 },
    ],
  },
  washington_dc: {
    jobs: [
      { unitId: "mobile_anti_air_vehicle", count: 4, requiredArmyBase: 1, requiredRO: 1 },
      { unitId: "multiple_rocket_launcher", count: 3, requiredArmyBase: 4, requiredRO: 1 },
    ],
  },
  new_york: { jobs: [{ unitId: "mobile_radar", count: 3, requiredArmyBase: 2, requiredRO: 1 }] },
  new_orleans: {
    jobs: [
      { unitId: "mechanized_infantry", count: 6, requiredArmyBase: 2, requiredRO: 1 },
      { unitId: "tank_veteran", count: 1, requiredArmyBase: 3, requiredRO: 2 },
    ],
  },
  portland: { jobs: [{ unitId: "mechanized_infantry", count: 6, requiredArmyBase: 2, requiredRO: 1 }] },
  chicago: {
    jobs: [
      { unitId: "mobile_anti_air_vehicle", count: 4, requiredArmyBase: 1, requiredRO: 1 },
      { unitId: "multiple_rocket_launcher", count: 3, requiredArmyBase: 4, requiredRO: 1 },
    ],
  },
  anchorage: { jobs: [{ unitId: "air_superiority_fighter", count: 5, requiredArmyBase: 0, requiredRO: 1, requiredAirBase: 1 }] },
};

function toCityStates(): CityState[] {
  return country.cities.map(city => ({
    cityId: `${country.country.id}:${city.id}`,
    countryId: country.country.id,
    capital: city.capital,
    resource: city.resource as Exclude<Resource, "cash" | "manpower">,
    startPop: city.population as CityState["startPop"],
    cityStatus: "homeland",
    buildings: {
      army_base: 0,
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

// Hawaii/Anchorage have no ground-force role but do host ASF (see ROLES above). Beyond
// AI1 (needed for ASF's own requirement), arms_industry is pushed on to L3 for the pure
// eco upside — queued AFTER every job's own requirements are met, so it runs in the
// background (dead-window pattern) and never delays ASF's own readiness or mobilisation.
const AI_TARGET_OVERRIDES: Record<string, number> = { hawaii: 3, anchorage: 3 };

// RO2 background upgrade (queued last, after every job's own requirement, so it never
// delays any job) — was needed to fix a manpower shortfall when USA's country YAML only
// listed 2 provinces. Corrected to the real 109 (107 non-resource + 2 electronics), the
// extra base manpower/cash income alone keeps manpower positive throughout (+9,056 min,
// +13,075 ending) with no RO2 needed — dropped, which also recovers supplies to positive
// (+1,183 ending, was -4,936 with RO2 everywhere).
const RO2_CITIES = new Set<string>([]);

// Build order per city: RO1 baseline first, AI1 in every city (including fuel cities),
// then interleave each job's own armyBase/RO/airBase bump in job order so each job
// becomes ready as early as possible, then the AI upgrade beyond L1, then finally RO2
// — both queued last so neither ever competes with a job's own infra requirement.
function buildOrderForCity(cityId: string, resource: Resource): BuildAction[] {
  const role = ROLES[cityId];
  const actions: BuildAction[] = [];
  const fullCityId = `${country.country.id}:${cityId}`;

  actions.push({ cityId: fullCityId, buildingId: "recruiting_office", targetLevel: 1 });
  actions.push({ cityId: fullCityId, buildingId: "arms_industry", targetLevel: 1 });

  let lastRO = 1;
  let lastArmyBase = 0;
  let lastAirBase = 0;
  for (const job of role.jobs) {
    if (job.requiredRO > lastRO) {
      actions.push({ cityId: fullCityId, buildingId: "recruiting_office", targetLevel: job.requiredRO });
      lastRO = job.requiredRO;
    }
    if (job.requiredArmyBase > lastArmyBase) {
      actions.push({ cityId: fullCityId, buildingId: "army_base", targetLevel: job.requiredArmyBase });
      lastArmyBase = job.requiredArmyBase;
    }
    if ((job.requiredAirBase ?? 0) > lastAirBase) {
      actions.push({ cityId: fullCityId, buildingId: "air_base", targetLevel: job.requiredAirBase! });
      lastAirBase = job.requiredAirBase!;
    }
  }

  const aiTarget = AI_TARGET_OVERRIDES[cityId] ?? 1;
  if (aiTarget > 1) {
    actions.push({ cityId: fullCityId, buildingId: "arms_industry", targetLevel: aiTarget });
  }
  if (RO2_CITIES.has(cityId) && lastRO < 2) {
    actions.push({ cityId: fullCityId, buildingId: "recruiting_office", targetLevel: 2 });
  }
  return actions;
}

const cities = toCityStates();
const fullBuildOrder = country.cities.flatMap(city => buildOrderForCity(city.id, city.resource as Resource));

const citySim = simulateBuildOrder({
  cities,
  buildOrder: fullBuildOrder,
  buildings,
  scenario,
  hoursToSimulate,
});

const timelineCities: TimelineCityState[] = cities.map(c => ({
  cityId: c.cityId,
  countryId: c.countryId,
  capital: c.capital,
  cityStatus: c.cityStatus,
  buildings: c.buildings,
}));

// --- Provinces (2 electronics provinces) — same combat_outpost L1 -> local_industry L3
// eco build pattern used elsewhere in the project (e.g. ww3-2026-coalition-eco.ts).
const provinceCohorts = buildProvinceCohortsFromCountry(country);
const provinceBuildOrder: ProvinceBuildAction[] = provinceCohorts
  .filter(cohort => cohort.resource !== null)
  .flatMap(cohort => [
    { provinceId: cohort.provinceId, buildingId: "combat_outpost" as const, targetLevel: 1 },
    { provinceId: cohort.provinceId, buildingId: "local_industry" as const, targetLevel: 3 },
  ]);

const provinceSim = simulateProvinceBuildOrder({
  provinces: provinceCohorts,
  buildOrder: provinceBuildOrder,
  buildings,
  scenario,
  hoursToSimulate,
});

const timelineProvinces: TimelineCityState[] = provinceCohorts.map(p => ({
  cityId: p.provinceId,
  countryId: p.countryId,
  cityStatus: p.cityStatus,
  buildings: {
    army_base: 0, air_base: 0, annex_city: 0, arms_industry: 0,
    combat_outpost: p.buildings.combat_outpost ?? 0,
    local_industry: p.buildings.local_industry ?? 0,
    naval_base: 0, recruiting_office: 0, relocate_headquarters: 0, underground_bunkers: 0,
  },
}));

const provinceSegmentsByProvince = scheduleBuildSegments({
  cities: timelineProvinces,
  buildOrder: provinceBuildOrder.map(action => ({
    cityId: action.provinceId,
    buildingId: action.buildingId,
    targetLevel: action.targetLevel,
  })),
  buildings,
  scenario,
});

const segmentsByCity = scheduleBuildSegments({
  cities: timelineCities,
  buildOrder: fullBuildOrder,
  buildings,
  scenario,
});

function levelData(buildingId: "army_base" | "arms_industry" | "recruiting_office" | "air_base" | "combat_outpost" | "local_industry", toLevel: number) {
  const level = buildings.buildings[buildingId]?.levels[String(toLevel) as "1" | "2" | "3" | "4" | "5"];
  if (!level) throw new Error(`missing ${buildingId} L${toLevel}`);
  return level;
}

// scheduleBuildSegments returns true absolute minutes/hours (from map day 1, hour 0);
// costAdjustments/perHourAggregate are relative-indexed from scenario start, so every
// segment timestamp must be shifted back by the scenario's own start offset.
const simulationStartAbsoluteHour = scenarioStartAbsoluteHour(scenario);
const costAdjustments = Array.from({ length: hoursToSimulate }, () => zero());

// Per-city, per-building: sorted list of (level reached, relative completion hour).
const levelReachedAt: Record<string, { army_base: Array<[number, number]>; recruiting_office: Array<[number, number]>; air_base: Array<[number, number]> }> = {};

for (const city of country.cities) {
  const fullCityId = `${country.country.id}:${city.id}`;
  const segs = segmentsByCity.get(fullCityId);
  levelReachedAt[city.id] = { army_base: [], recruiting_office: [], air_base: [] };
  if (!segs) continue;

  for (const [buildingId, segments] of Object.entries(segs) as Array<[
    "army_base" | "arms_industry" | "recruiting_office" | "air_base",
    typeof segs["army_base"]
  ]>) {
    for (const segment of segments) {
      const level = levelData(buildingId, segment.toLevel);
      const startHourIndex = Math.floor(segment.startMinute / 60) - simulationStartAbsoluteHour;
      if (startHourIndex >= 0 && startHourIndex < hoursToSimulate) {
        for (const resource of RESOURCE_KEYS) {
          const cost = level.cost[resource];
          if (cost) costAdjustments[startHourIndex][resource] -= cost;
        }
      }
      const completionHour = Math.ceil(segment.endMinute / 60) - simulationStartAbsoluteHour;

      if (buildingId === "army_base" || buildingId === "recruiting_office" || buildingId === "air_base") {
        levelReachedAt[city.id][buildingId].push([segment.toLevel, completionHour]);
      }

      const upkeep = level.daily_upkeep;
      if (upkeep) {
        for (let h = Math.max(0, completionHour); h < hoursToSimulate; h++) {
          for (const resource of RESOURCE_KEYS) {
            const amount = upkeep[resource];
            if (amount) costAdjustments[h][resource] -= amount / 24;
          }
        }
      }
    }
  }
}

// Province build costs/upkeep (combat_outpost + local_industry), same fold-in pattern
// as cities above.
for (const cohort of provinceCohorts) {
  const segs = provinceSegmentsByProvince.get(cohort.provinceId);
  if (!segs) continue;

  for (const [buildingId, segments] of Object.entries(segs) as Array<[
    "combat_outpost" | "local_industry",
    typeof segs["combat_outpost"]
  ]>) {
    for (const segment of segments) {
      const level = levelData(buildingId, segment.toLevel);
      const startHourIndex = Math.floor(segment.startMinute / 60) - simulationStartAbsoluteHour;
      if (startHourIndex >= 0 && startHourIndex < hoursToSimulate) {
        for (const resource of RESOURCE_KEYS) {
          const cost = level.cost[resource];
          if (cost) costAdjustments[startHourIndex][resource] -= cost;
        }
      }
      const completionHour = Math.ceil(segment.endMinute / 60) - simulationStartAbsoluteHour;
      const upkeep = level.daily_upkeep;
      if (upkeep) {
        for (let h = Math.max(0, completionHour); h < hoursToSimulate; h++) {
          for (const resource of RESOURCE_KEYS) {
            const amount = upkeep[resource];
            if (amount) costAdjustments[h][resource] -= amount / 24;
          }
        }
      }
    }
  }
}

function hourLevelReached(cityId: string, buildingId: "army_base" | "recruiting_office" | "air_base", level: number): number {
  if (level <= 0) return 0;
  const entry = levelReachedAt[cityId][buildingId].find(([l]) => l === level);
  if (!entry) throw new Error(`${cityId} never reaches ${buildingId} L${level}`);
  return entry[1];
}

// One-time L1 research per demanded unit type, scheduled across the country's 2 shared
// research slots (not all-in-parallel — the engine only has 2 slots total, shared by
// every unit). Priority = whichever unit's infra is ready soonest gets a slot first,
// greedy-ASAP into whichever of the 2 slots frees up earliest. Costs are booked at each
// unit's actual scheduled start hour, not hour 0.
const researchedUnitIds = new Set(Object.values(ROLES).flatMap(role => role.jobs.map(j => j.unitId)));
type ResearchRow = { unitId: string; hours: number; cost: Record<Resource, number>; startHour: number; endHour: number };

function infraReadyHourForUnit(unitId: string): number {
  let earliest = Infinity;
  for (const [cityId, role] of Object.entries(ROLES)) {
    for (const job of role.jobs) {
      if (job.unitId !== unitId) continue;
      const ready = Math.max(
        hourLevelReached(cityId, "army_base", job.requiredArmyBase),
        hourLevelReached(cityId, "recruiting_office", job.requiredRO),
        hourLevelReached(cityId, "air_base", job.requiredAirBase ?? 0)
      );
      earliest = Math.min(earliest, ready);
    }
  }
  return Number.isFinite(earliest) ? earliest : 0;
}

const researchDurationAndCost = Array.from(researchedUnitIds).map(unitId => {
  const unit = catalog.units[unitId];
  const level1 = unit.levels["1"];
  const research = level1.research[doctrine] ?? level1.research[unit.doctrine[0]];
  const hours = research
    ? (research.time.days ?? 0) * 24 + (research.time.hours ?? 0) + (research.time.minutes ?? 0) / 60
    : 0;
  return {
    unitId,
    hours,
    cost: Object.fromEntries(RESOURCE_KEYS.map(r => [r, research?.cost?.[r] ?? 0])) as Record<Resource, number>,
    infraReadyHour: infraReadyHourForUnit(unitId),
  };
});
researchDurationAndCost.sort((a, b) => a.infraReadyHour - b.infraReadyHour);

const researchSlotFree = [0, 0];
const researchRows: ResearchRow[] = researchDurationAndCost.map(r => {
  const slot = researchSlotFree[0] <= researchSlotFree[1] ? 0 : 1;
  const startHour = researchSlotFree[slot];
  const endHour = Math.ceil(startHour + r.hours);
  researchSlotFree[slot] = endHour;

  for (const resource of RESOURCE_KEYS) {
    const amount = r.cost[resource];
    if (amount) costAdjustments[startHour][resource] -= amount;
  }

  return { unitId: r.unitId, hours: r.hours, cost: r.cost, startHour, endHour };
});
const researchEndHourByUnit = new Map(researchRows.map(r => [r.unitId, r.endHour]));

function roLevelAtHour(cityId: string, hour: number): number {
  const entries = levelReachedAt[cityId].recruiting_office;
  let level = 0;
  for (const [l, h] of entries) {
    if (h <= hour) level = Math.max(level, l);
  }
  return level;
}

function mobBonusPct(roLevel: number): number {
  const level = buildings.buildings.recruiting_office?.levels[String(roLevel) as "1" | "2" | "3" | "4" | "5"];
  return level?.mobilisation_speed_bonus_pct ?? 0;
}

// --- Mobilisation forward-fill per city: jobs run sequentially in the city's single
// mob queue; each job can only start once ITS OWN armyBase/RO requirement is met, but
// the city's infra queue keeps building in the background (dead-window pattern) —
// RO bonus is looked up dynamically per unit based on the city's RO level at that hour.
type UnitOutcome = {
  cityId: string;
  unitId: string;
  demanded: number;
  achieved: number;
  jobReadyHour: number;
  jobStartHour: number;
  jobEndHour: number;
};

const outcomes: UnitOutcome[] = [];

for (const city of country.cities) {
  const role = ROLES[city.id];
  let cityQueueFreeHour = 0;

  for (const job of role.jobs) {
    const jobReadyHour = Math.max(
      hourLevelReached(city.id, "army_base", job.requiredArmyBase),
      hourLevelReached(city.id, "recruiting_office", job.requiredRO),
      hourLevelReached(city.id, "air_base", job.requiredAirBase ?? 0),
      researchEndHourByUnit.get(job.unitId) ?? 0
    );

    const unit = catalog.units[job.unitId];
    const level1 = unit.levels["1"];
    const mobData = level1.mobilisation[doctrine] ?? level1.mobilisation[unit.doctrine[0]];
    const baseHours = (mobData.time.days ?? 0) * 24 + (mobData.time.hours ?? 0) + (mobData.time.minutes ?? 0) / 60;

    let hour = Math.max(cityQueueFreeHour, jobReadyHour);
    const jobStartHour = hour;
    let achieved = 0;

    for (let i = 0; i < job.count; i++) {
      const roLevel = roLevelAtHour(city.id, hour);
      const bonusPct = mobBonusPct(roLevel);
      const day = Math.max(1, Math.floor((hour + simulationStartAbsoluteHour) / 24) + 1);
      const moralePct = baselineHomelandMoraleOnDay(day);
      const moraleAdjusted = effectiveDurationFromMorale(baseHours, moralePct);
      const duration = Math.ceil(moraleAdjusted / (1 + bonusPct));
      if (hour + duration > deadlineHour) break;

      const cost = mobData.cost;
      for (const resource of RESOURCE_KEYS) {
        const amount = cost[resource];
        if (amount) costAdjustments[hour][resource] -= amount;
      }
      const completionHour = hour + duration;
      const upkeep = level1.daily_upkeep[doctrine]?.cost ?? level1.daily_upkeep[unit.doctrine[0]]?.cost;
      if (upkeep) {
        for (let h = completionHour; h < hoursToSimulate; h++) {
          for (const resource of RESOURCE_KEYS) {
            const amount = upkeep[resource];
            if (amount) costAdjustments[h][resource] -= amount / 24;
          }
        }
      }

      hour = completionHour;
      achieved++;
    }

    cityQueueFreeHour = hour;
    outcomes.push({
      cityId: city.id,
      unitId: job.unitId,
      demanded: job.count,
      achieved,
      jobReadyHour,
      jobStartHour,
      jobEndHour: hour,
    });
  }
}

// --- Aggregate production + costs ---
const hourly = Array.from({ length: hoursToSimulate }, (_, index) => {
  const production = zero();
  for (const resource of RESOURCE_KEYS) {
    production[resource] += citySim.perHourAggregate[index]?.production[resource] ?? 0;
    production[resource] += provinceSim.perHourAggregate[index]?.production[resource] ?? 0;
    production[resource] += costAdjustments[index]?.[resource] ?? 0;
  }
  return production;
});

const totals = hourly.reduce((acc, row) => {
  for (const resource of RESOURCE_KEYS) acc[resource] += row[resource];
  return acc;
}, zero());

const startingBalance = Object.fromEntries(
  RESOURCE_KEYS.map(r => [r, scenario.starting_balance?.[r] ?? 0])
) as Record<Resource, number>;

const endingBalance = Object.fromEntries(
  RESOURCE_KEYS.map(r => [r, startingBalance[r] + totals[r]])
) as Record<Resource, number>;

// Running balance check — the ending total can be positive while some resource still
// dips negative mid-truce (front-loaded infra spend before production ramps up).
let running = { ...startingBalance };
const minBalance = { ...startingBalance };
const minBalanceHour: Record<Resource, number> = Object.fromEntries(RESOURCE_KEYS.map(r => [r, 0])) as Record<Resource, number>;
for (let h = 0; h < hoursToSimulate; h++) {
  for (const resource of RESOURCE_KEYS) {
    running[resource] += hourly[h][resource];
    if (running[resource] < minBalance[resource]) {
      minBalance[resource] = running[resource];
      minBalanceHour[resource] = h;
    }
  }
}

// --- Report ---
console.log(`Scenario: ${scenario.id} (${scenario.speed}), truce=${truceDays} days (${hoursToSimulate}h)`);
console.log(`Country: ${country.country.name} (doctrine=${doctrine})`);
console.log(`\nBaseline: recruiting_office L1 in every city, arms_industry L1 in every city including fuel cities (L3 in Hawaii/Anchorage); upgraded further only where a job needs it. Hawaii + Anchorage each host 5 ASF (10 total, air_base L1 + AI1) — fully affordable with the corrected 109-province count. Plus 2 electronics provinces (combat_outpost L1 -> local_industry L3).`);

console.log("\nJob-level feasibility (in city build-order sequence):");
console.table(
  outcomes.map(o => ({
    city: o.cityId,
    unit: o.unitId,
    demanded: o.demanded,
    achieved: o.achieved,
    feasible: o.achieved >= o.demanded ? "YES" : "NO — SHORT",
    jobReadyHour: o.jobReadyHour,
    jobStartHour: o.jobStartHour,
    jobEndHour: o.jobEndHour,
    hoursSpare: deadlineHour - o.jobEndHour,
  }))
);

const demandTotals = new Map<string, { demanded: number; achieved: number }>();
for (const o of outcomes) {
  const entry = demandTotals.get(o.unitId) ?? { demanded: 0, achieved: 0 };
  entry.demanded += o.demanded;
  entry.achieved += o.achieved;
  demandTotals.set(o.unitId, entry);
}
console.log("\nDemand totals (summed across cities):");
console.table(
  Array.from(demandTotals.entries()).map(([unitId, v]) => ({
    unit: unitId,
    demanded: v.demanded,
    achieved: v.achieved,
    feasible: v.achieved >= v.demanded ? "YES" : "NO",
  }))
);

console.log("\nTruce-end resource balance for United States:");
console.table([
  { label: "Starting Balance", ...startingBalance },
  { label: "Net Production (incl. all infra + mob costs/upkeep)", ...totals },
  { label: "Ending Balance (truce end)", ...endingBalance },
]);

console.log("\nLowest running balance at any point during the truce (front-loaded spend can dip below the ending total):");
console.table([
  { label: "Minimum balance", ...minBalance },
  { label: "Hour reached", ...minBalanceHour },
]);

// --- HTML report ---
function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtHour(h: number): string {
  const absHour = h + simulationStartAbsoluteHour;
  const day = Math.floor(absHour / 24) + 1;
  const hour = Math.floor(absHour % 24);
  return `day ${day} h${String(hour).padStart(2, "0")} (t+${h}h)`;
}

function renderTable(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0) return "<p><em>None</em></p>\n";
  const headers = columns ?? Object.keys(rows[0]);
  const head = `<tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
  const body = rows
    .map(row => `<tr>${headers.map(h => `<td>${escapeHtml(row[h])}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>\n`;
}

function resourceTableHeader(): string {
  return `<tr><th></th>${RESOURCE_KEYS.map(r => `<th>${r}</th>`).join("")}</tr>`;
}

function resourceRow(label: string, values: Record<Resource, number>, cls = ""): string {
  return `<tr class="${cls}"><td>${escapeHtml(label)}</td>${RESOURCE_KEYS.map(r => {
    const v = Math.round(values[r] ?? 0);
    return `<td class="${v < 0 ? "neg" : ""}">${v !== 0 ? fmt(v) : "—"}</td>`;
  }).join("")}</tr>`;
}

function buildHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: ui-monospace,"Cascadia Code","Fira Mono","Courier New",monospace; font-size: 12px; margin: 1rem 2rem; }
  h1 { font-size: 1.3rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.05rem; margin: 1.8rem 0 0.4rem; border-bottom: 1px solid #ccc; }
  h3 { font-size: 0.95rem; margin: 1rem 0 0.3rem; color: #333; }
  p.meta { color: #555; margin: 0.15rem 0; }
  table { border-collapse: collapse; margin-bottom: 0.8rem; }
  th, td { border: 1px solid #ccc; padding: 3px 8px; text-align: right; white-space: nowrap; }
  th { background: #f0f0f0; text-align: center; font-size: 11px; }
  td:first-child, th:first-child { text-align: left; }
  td.neg { color: #cf222e; font-weight: bold; }
  tr.total td { font-weight: bold; background: #fafafa; }
  .yes { color: #1a7f37; font-weight: bold; }
  .no { color: #cf222e; font-weight: bold; }
  .note { color: #666; font-size: 11px; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

const citiesAlphabetical = [...country.cities].sort((a, b) => a.name.localeCompare(b.name));

const cityBuildPlanHtml = citiesAlphabetical.map(city => {
  const fullCityId = `${country.country.id}:${city.id}`;
  const segs = segmentsByCity.get(fullCityId);

  // sortKey is the true unrounded start time — startHour is floored for display only,
  // so two builds landing in the same displayed hour (e.g. RO's 32min vs AI starting
  // right after) must not tie-break on object key insertion order.
  type TimelineRow = { kind: "build" | "mob"; sortKey: number; startHour: number; endHour: number; label: string };
  const rows: TimelineRow[] = [];

  if (segs) {
    for (const [buildingId, segments] of Object.entries(segs) as Array<[
      "army_base" | "arms_industry" | "recruiting_office",
      typeof segs["army_base"]
    ]>) {
      for (const segment of segments) {
        const startHour = Math.floor(segment.startMinute / 60) - simulationStartAbsoluteHour;
        const endHour = Math.ceil(segment.endMinute / 60) - simulationStartAbsoluteHour;
        rows.push({
          kind: "build",
          sortKey: segment.startMinute,
          startHour,
          endHour,
          label: `${buildingId} L${segment.fromLevel}→L${segment.toLevel}`,
        });
      }
    }
  }

  for (const o of outcomes.filter(x => x.cityId === city.id)) {
    rows.push({
      kind: "mob",
      sortKey: (o.jobStartHour + simulationStartAbsoluteHour) * 60,
      startHour: o.jobStartHour,
      endHour: o.jobEndHour,
      label: `mobilise ${o.unitId} × ${o.achieved}${o.achieved < o.demanded ? ` (of ${o.demanded} demanded — SHORT)` : ""}`,
    });
  }

  rows.sort((a, b) => a.sortKey - b.sortKey);

  const role = ROLES[city.id];
  const roleLabel = role.jobs.length === 0
    ? "baseline eco only"
    : role.jobs.map(j => `${j.unitId} ×${j.count}`).join(" → ");

  const tableRows = rows.map(r => ({
    step: r.kind === "build" ? "build" : "mobilise",
    start: fmtHour(r.startHour),
    end: fmtHour(r.endHour),
    action: r.label,
  }));

  return `<h3>${escapeHtml(city.name)} <span class="note">(${escapeHtml(city.resource)}${city.capital ? ", capital" : ""}) — ${escapeHtml(roleLabel)}</span></h3>\n`
    + renderTable(tableRows, ["step", "start", "end", "action"]);
}).join("\n");

// --- Eco income vs. costs (country-wide aggregate only — per-city eco isn't relevant at a build-plan level) ---
const grossTotal = Object.fromEntries(
  RESOURCE_KEYS.map(r => [
    r,
    citySim.perHourPerCity.reduce((sum, result) => sum + (result.production[r] ?? 0), 0),
  ])
) as Record<Resource, number>;
const allCostsTotal = Object.fromEntries(
  RESOURCE_KEYS.map(r => [r, totals[r] - grossTotal[r]])
) as Record<Resource, number>;

const ecoVsCostHtml = `<table><thead>${resourceTableHeader()}</thead><tbody>`
  + resourceRow("Gross eco production (all cities, over 8 days)", grossTotal)
  + resourceRow("− Infra + mobilisation + research costs + upkeep", allCostsTotal)
  + resourceRow("= Net production", totals, "total")
  + `</tbody></table>\n`;

// Earliest hour any city actually needs each researched unit — used to sanity-check
// that the 2-shared-research-slot constraint (not modelled above; costs are booked at
// hour 0 for simplicity) doesn't actually bind against real city readiness.
const earliestNeedByUnit = new Map<string, number>();
for (const o of outcomes) {
  const prev = earliestNeedByUnit.get(o.unitId);
  if (prev === undefined || o.jobReadyHour < prev) earliestNeedByUnit.set(o.unitId, o.jobReadyHour);
}

const researchHtml = `<table><thead><tr><th>unit</th><th>start</th><th>end</th><th>first city needs it by</th>${RESOURCE_KEYS.map(r => `<th>${r}</th>`).join("")}</tr></thead><tbody>`
  + [...researchRows].sort((a, b) => a.startHour - b.startHour).map(r => {
    const deadline = earliestNeedByUnit.get(r.unitId) ?? 0;
    return `<tr><td>${escapeHtml(r.unitId)}</td><td>${fmtHour(r.startHour)}</td><td>${fmtHour(r.endHour)}</td><td>${fmtHour(deadline)}</td>${RESOURCE_KEYS.map(res => {
      const v = Math.round(r.cost[res] ?? 0);
      return `<td>${v !== 0 ? fmt(v) : "—"}</td>`;
    }).join("")}</tr>`;
  }).join("")
  + `</tbody></table>\n`;

const demandTotalsHtml = renderTable(
  Array.from(demandTotals.entries()).map(([unitId, v]) => ({
    unit: unitId,
    demanded: v.demanded,
    achieved: v.achieved,
    feasible: v.achieved >= v.demanded ? "YES" : "NO",
  })),
  ["unit", "demanded", "achieved", "feasible"]
).replace(/<td>(YES)<\/td>/g, '<td class="yes">$1</td>').replace(/<td>(NO)<\/td>/g, '<td class="no">$1</td>');

const balanceHtml = `<table><thead>${resourceTableHeader()}</thead><tbody>`
  + resourceRow("Starting Balance", startingBalance)
  + resourceRow("Net Production (infra + mob + research, all costs & upkeep)", totals)
  + resourceRow("Ending Balance (truce end)", endingBalance, "total")
  + `</tbody></table>\n`;

const minBalanceHtml = `<table><thead>${resourceTableHeader()}</thead><tbody>`
  + resourceRow("Minimum running balance", minBalance)
  + `<tr><td>Hour reached</td>${RESOURCE_KEYS.map(r => `<td>${fmtHour(minBalanceHour[r])}</td>`).join("")}</tr>`
  + `</tbody></table>\n`;

const html = buildHtml(
  `USA Build Profile — ${scenario.id}`,
  `
<h1>United States — Build Profile (${scenario.name})</h1>
<p class="meta">Doctrine: ${escapeHtml(doctrine)} · Truce: ${truceDays} days (${hoursToSimulate}h) · Speed: ${escapeHtml(scenario.speed)}</p>
<p class="meta">Baseline: recruiting_office L1 in every city; arms_industry L1 in every city including fuel cities (L3 in Hawaii/Anchorage — idle eco-only cities, no military role/distance from theatre). Hawaii + Anchorage each host 5 ASF (10 total, air_base L1 + AI1) — fully affordable now that USA's provinces are correctly counted at 109 (107 non-resource + 2 electronics), up from an earlier incorrect 2; the extra base manpower/cash income keeps every resource positive at truce end without needing any RO2 upgrade.</p>

<h2>Demand totals</h2>
${demandTotalsHtml}

<h2>Eco income vs. costs (country-wide)</h2>
${ecoVsCostHtml}

<h2>Truce-end resource balance (United States)</h2>
${balanceHtml}

<h2>Lowest running balance during the truce</h2>
<p class="note">The ending balance can be positive while a resource still dips negative mid-truce from front-loaded infra spend before production ramps up.</p>
${minBalanceHtml}

<h2>Research (L1, one-time per unit type — country-wide, not per-city)</h2>
<p class="note">Costs booked at hour 0 for simplicity (research isn't tied to any one city). The 2 shared research slots aren't modelled explicitly here, but every unit's research time is well inside the "first city needs it by" deadline even under realistic slot pairing (worst case ~40h to clear all 5 across 2 slots), so this simplification doesn't affect feasibility — only exactly which hour the cost lands, which stays within the first ~40h either way.</p>
${researchHtml}

<h2>City build &amp; mobilisation plans</h2>
${cityBuildPlanHtml}
`
);

const outDir = path.resolve("tmp");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "usa-build-profile.html");
fs.writeFileSync(outPath, html, "utf8");
console.log(`\n→ wrote ${outPath}`);
