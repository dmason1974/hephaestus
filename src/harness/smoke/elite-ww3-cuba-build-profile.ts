import fs from "node:fs";
import path from "node:path";

import type { Resource } from "../../core/constants.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import { baselineHomelandMoraleOnDay } from "../../engine/economy/morale.js";
import { effectiveDurationFromMorale } from "../../engine/timing/activity-duration.js";
import type { BuildAction, CityState } from "../../engine/simulation/build-order-sim.js";
import { simulateBuildOrder } from "../../engine/simulation/build-order-sim.js";
import { scheduleBuildSegments, type TimelineCityState } from "../../engine/orchestration/build-order-timeline.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadMergedUnitCatalogForScenario } from "../../scenarios/io/load-unit-catalog.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";

const scenarioId = "elite/ww3";
const buildings = loadBuildingsFile(path.resolve("data/buildings.yml"));
const catalog = loadMergedUnitCatalogForScenario(scenarioId);
const scenario = loadScenarioFile(scenarioId);
const country = loadScenarioCountry(scenarioId, "cuba");
const doctrine = country.country.doctrine; // eastern

const truceDays = scenario.truce_length_days ?? 28;
const hoursToSimulate = truceDays * 24;
const deadlineHour = hoursToSimulate;
const simulationStartAbsoluteHour = scenarioStartAbsoluteHour(scenario);

const RESOURCE_KEYS: Resource[] = ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"];
function zero(): Record<Resource, number> {
  return { supplies: 0, components: 0, fuel: 0, rares: 0, electronics: 0, cash: 0, manpower: 0 };
}

// --- City assignment plan ---
// Naval demands (Naval Veteran, Elite Frigate, Cruiser) split across 2 cities per the
// brief. Camagüey does Naval Veteran + Elite Frigate first (dead window under
// naval_base L2, since all 3 naval units only need L2 except Cruiser's L4), then
// continues to naval_base L4 for its share of Cruisers. Cienfuegos is a dedicated
// Cruiser city. Havana (already starts with air_base 1) hosts both helicopter units —
// Rotary Wing Veteran needs only air_base L1 (already there), ASW needs L2, so Rotary
// Wing Veteran mobilises in the dead window while air_base builds to L2 in the
// background. Santa Clara / Santiago de Cuba stay pure eco (idle, like Hawaii/Anchorage
// in the USA plan).
type Job = {
  unitId: string;
  count: number;
  requiredNavalBase?: number;
  requiredAirBase?: number;
  requiredRO?: number;
};
type Role = { jobs: Job[] };

const ROLES: Record<string, Role> = {
  santa_clara: { jobs: [] },
  // Santiago de Cuba takes over Camagüey's naval role entirely, freeing Camagüey to run
  // pure eco (RO1 + AI5) for the full 8 days — same "idle city + high AI" pattern that
  // worked for USA's Hawaii/Anchorage.
  santiago_de_cuba: {
    jobs: [
      { unitId: "naval_veteran", count: 1, requiredNavalBase: 2, requiredRO: 1 },
      { unitId: "elite_frigate", count: 2, requiredNavalBase: 2 },
      { unitId: "cruiser", count: 3, requiredNavalBase: 4 },
    ],
  },
  camaguey: { jobs: [] },
  cienfuegos: {
    jobs: [
      { unitId: "elite_frigate", count: 2, requiredNavalBase: 2 },
      { unitId: "cruiser", count: 2, requiredNavalBase: 4 },
    ],
  },
  havana: {
    jobs: [
      { unitId: "rotary_wing_veteran", count: 1, requiredAirBase: 1, requiredRO: 1 },
      { unitId: "asw_helicopter", count: 4, requiredAirBase: 2 },
    ],
  },
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

// Tried pushing Camagüey/Cienfuegos to naval_base L5 + arms_industry L4 after their own
// jobs' requirements, for the production_bonus_pct on their native resource. Made the
// deficit WORSE (electronics -22,374 -> -25,204, components -6,037 -> -10,609): unlike
// Hawaii/Anchorage in the USA plan (fully idle, ~180h to enjoy the bonus), Camagüey and
// Cienfuegos are busy with Cruiser mobilisation for nearly the whole truce — the upgrade
// only gets to run for the last ~25h before the deadline, nowhere near enough to recoup
// its own build cost (which itself draws on the same scarce electronics/components).
// AI4-only (no naval_base5) was also tested: electronics barely moved (-22,374 ->
// -22,333) and components got slightly worse (-6,037 -> -6,165) — the build cost
// roughly cancels the production gain in the short remaining window when the city is
// still busy with Cruiser mobilisation. Camagüey is now pure eco instead (see ROLES —
// its naval role moved to Santiago de Cuba), so AI5's full production_bonus_pct
// (+50%) runs for nearly the whole 8 days with zero mobilisation opportunity cost.
// Won't close the whole electronics gap, but should recover a substantial chunk of it.
//
// Ran the actual eco beam search (smoke:eco-plan) for Camagüey as an unconstrained pure
// eco city rather than guessing further — its true optimal sequence does NOT include
// naval_base at all (contrary to the naval_base L2 idea), just progressive
// arms_industry with one underground_bunkers L1 inserted after AI L2:
//   L1 AI -> L2 AI -> L1 underground_bunkers -> L3 AI -> L4 AI -> L5 AI
// Using that exact order (not a single AI1->5 jump) since insertion order affects when
// the bunker's morale bonus starts applying relative to the later AI levels.
// relocate_headquarters (+25 morale, 15,000 cash + 2,500 manpower, 36h) wasn't in the
// beam's own optimal pick because the beam only optimizes within this 8-day window — its
// morale bonus is permanent/ongoing beyond the truce, which the beam can't see. Inserted
// early (right after baseline AI1) so the maximum number of remaining hours benefit from
// the higher morale multiplier, for max electronics output rather than max 8-day ROI.
const NAVAL_BASE_TARGET_OVERRIDES: Record<string, number> = {};
const AI_TARGET_OVERRIDES: Record<string, number> = {};
const ECO_TAIL_SEQUENCE: Record<string, Array<{ buildingId: "arms_industry" | "underground_bunkers" | "relocate_headquarters"; targetLevel: number }>> = {
  camaguey: [
    { buildingId: "relocate_headquarters", targetLevel: 1 },
    { buildingId: "arms_industry", targetLevel: 2 },
    { buildingId: "underground_bunkers", targetLevel: 1 },
    { buildingId: "arms_industry", targetLevel: 5 },
  ],
};

// Build order per city: RO1 baseline first, then AI1 (per the brief: "RO1 in all
// cities, then arms industry one"), then interleave each job's own naval_base/air_base
// bump in job order so each job becomes ready as early as possible, then finally any
// naval_base/AI upgrade beyond what the jobs themselves needed.
function buildOrderForCity(cityId: string): BuildAction[] {
  const role = ROLES[cityId];
  const actions: BuildAction[] = [];
  const fullCityId = `${country.country.id}:${cityId}`;

  actions.push({ cityId: fullCityId, buildingId: "recruiting_office", targetLevel: 1 });
  actions.push({ cityId: fullCityId, buildingId: "arms_industry", targetLevel: 1 });

  let lastRO = 1;
  let lastNavalBase = 1; // all Cuba cities start at naval_base 1
  let lastAirBase = country.cities.find(c => c.id === cityId)!.starting.air_base;
  for (const job of role.jobs) {
    if ((job.requiredRO ?? 0) > lastRO) {
      actions.push({ cityId: fullCityId, buildingId: "recruiting_office", targetLevel: job.requiredRO! });
      lastRO = job.requiredRO!;
    }
    if ((job.requiredNavalBase ?? 0) > lastNavalBase) {
      actions.push({ cityId: fullCityId, buildingId: "naval_base", targetLevel: job.requiredNavalBase! });
      lastNavalBase = job.requiredNavalBase!;
    }
    if ((job.requiredAirBase ?? 0) > lastAirBase) {
      actions.push({ cityId: fullCityId, buildingId: "air_base", targetLevel: job.requiredAirBase! });
      lastAirBase = job.requiredAirBase!;
    }
  }

  const navalTarget = NAVAL_BASE_TARGET_OVERRIDES[cityId] ?? 0;
  if (navalTarget > lastNavalBase) {
    actions.push({ cityId: fullCityId, buildingId: "naval_base", targetLevel: navalTarget });
  }
  const aiTarget = AI_TARGET_OVERRIDES[cityId] ?? 1;
  if (aiTarget > 1) {
    actions.push({ cityId: fullCityId, buildingId: "arms_industry", targetLevel: aiTarget });
  }
  for (const step of ECO_TAIL_SEQUENCE[cityId] ?? []) {
    actions.push({ cityId: fullCityId, buildingId: step.buildingId, targetLevel: step.targetLevel });
  }
  return actions;
}

const cities = toCityStates();
const fullBuildOrder = country.cities.flatMap(city => buildOrderForCity(city.id));

const citySim = simulateBuildOrder({ cities, buildOrder: fullBuildOrder, buildings, scenario, hoursToSimulate });

const timelineCities: TimelineCityState[] = cities.map(c => ({
  cityId: c.cityId,
  countryId: c.countryId,
  capital: c.capital,
  cityStatus: c.cityStatus,
  buildings: c.buildings,
}));

const segmentsByCity = scheduleBuildSegments({ cities: timelineCities, buildOrder: fullBuildOrder, buildings, scenario });

function levelData(
  buildingId: "naval_base" | "arms_industry" | "recruiting_office" | "air_base" | "combat_outpost" | "underground_bunkers",
  toLevel: number
) {
  const level = buildings.buildings[buildingId]?.levels[String(toLevel) as "1" | "2" | "3" | "4" | "5"];
  if (!level) throw new Error(`missing ${buildingId} L${toLevel}`);
  return level;
}

const costAdjustments = Array.from({ length: hoursToSimulate }, () => zero());

const levelReachedAt: Record<
  string,
  { naval_base: Array<[number, number]>; recruiting_office: Array<[number, number]>; air_base: Array<[number, number]> }
> = {};

for (const city of country.cities) {
  const fullCityId = `${country.country.id}:${city.id}`;
  const segs = segmentsByCity.get(fullCityId);
  levelReachedAt[city.id] = { naval_base: [], recruiting_office: [], air_base: [] };
  if (!segs) continue;

  for (const [buildingId, segments] of Object.entries(segs) as Array<[
    "naval_base" | "arms_industry" | "recruiting_office" | "air_base" | "underground_bunkers",
    typeof segs["naval_base"]
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
      if (buildingId === "naval_base" || buildingId === "recruiting_office" || buildingId === "air_base") {
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

const startingLevelByCity: Record<string, { naval_base: number; air_base: number }> = Object.fromEntries(
  country.cities.map(c => [c.id, { naval_base: c.starting.naval_base, air_base: c.starting.air_base }])
);

function hourLevelReached(cityId: string, buildingId: "naval_base" | "recruiting_office" | "air_base", level: number): number {
  if (level <= 0) return 0;
  if (buildingId !== "recruiting_office" && startingLevelByCity[cityId][buildingId] >= level) return 0;
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
// elite_frigate requires frigate level 1 (research prerequisite, not mobilised) — needs
// its own research scheduled too.
researchedUnitIds.add("frigate");

type ResearchRow = { unitId: string; hours: number; cost: Record<Resource, number>; startHour: number; endHour: number };

function infraReadyHourForUnit(unitId: string): number {
  let earliest = Infinity;
  for (const [cityId, role] of Object.entries(ROLES)) {
    for (const job of role.jobs) {
      if (job.unitId !== unitId) continue;
      const ready = Math.max(
        hourLevelReached(cityId, "naval_base", job.requiredNavalBase ?? 0),
        hourLevelReached(cityId, "air_base", job.requiredAirBase ?? 0)
      );
      earliest = Math.min(earliest, ready);
    }
  }
  // frigate itself is never mobilised (only researched, as elite_frigate's prerequisite)
  // — treat it as needed as early as elite_frigate's own infra readiness.
  if (unitId === "frigate") return infraReadyHourForUnit("elite_frigate");
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
// elite_frigate requires "frigate level 1" — its research can't even START until
// frigate's research finishes (sequential dependency), not just run in a parallel slot.
// Schedule the prerequisite first (regardless of infra-priority ranking) so this holds.
const RESEARCH_PREREQUISITES: Record<string, string> = { elite_frigate: "frigate" };
researchDurationAndCost.sort((a, b) => {
  if (RESEARCH_PREREQUISITES[a.unitId] === b.unitId) return 1;
  if (RESEARCH_PREREQUISITES[b.unitId] === a.unitId) return -1;
  return a.infraReadyHour - b.infraReadyHour;
});

const researchSlotFree = [0, 0];
const researchEndHourByUnit = new Map<string, number>();
const researchRows: ResearchRow[] = researchDurationAndCost.map(r => {
  const slot = researchSlotFree[0] <= researchSlotFree[1] ? 0 : 1;
  const prereq = RESEARCH_PREREQUISITES[r.unitId];
  const notBefore = prereq ? researchEndHourByUnit.get(prereq) ?? 0 : 0;
  const startHour = Math.max(researchSlotFree[slot], notBefore);
  const endHour = Math.ceil(startHour + r.hours);
  researchSlotFree[slot] = endHour;
  researchEndHourByUnit.set(r.unitId, endHour);

  for (const resource of RESOURCE_KEYS) {
    const amount = r.cost[resource];
    if (amount) costAdjustments[startHour][resource] -= amount;
  }

  return { unitId: r.unitId, hours: r.hours, cost: r.cost, startHour, endHour };
});

function roLevelAtHour(cityId: string, hour: number): number {
  const entries = levelReachedAt[cityId].recruiting_office;
  let level = 0;
  for (const [l, h] of entries) if (h <= hour) level = Math.max(level, l);
  return level;
}

function mobBonusPct(roLevel: number): number {
  const level = buildings.buildings.recruiting_office?.levels[String(roLevel) as "1" | "2" | "3" | "4" | "5"];
  return level?.mobilisation_speed_bonus_pct ?? 0;
}

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
      hourLevelReached(city.id, "naval_base", job.requiredNavalBase ?? 0),
      hourLevelReached(city.id, "air_base", job.requiredAirBase ?? 0),
      hourLevelReached(city.id, "recruiting_office", job.requiredRO ?? 0),
      researchEndHourByUnit.get(job.unitId) ?? 0,
      job.unitId === "elite_frigate" ? (researchEndHourByUnit.get("frigate") ?? 0) : 0
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
      const duration = Math.ceil(effectiveDurationFromMorale(baseHours, moralePct) / (1 + bonusPct));
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
    outcomes.push({ cityId: city.id, unitId: job.unitId, demanded: job.count, achieved, jobReadyHour, jobStartHour, jobEndHour: hour });
  }
}

// --- Coastal Battery: 3 individual non-resource provinces, 5 each. No RO/AI (provinces
// don't have those buildings) — each site just builds combat_outpost L1 then mobilises
// coastal_battery L1 repeatedly at base speed (no RO bonus).
const COASTAL_SITES = ["coastal_site_1", "coastal_site_2", "coastal_site_3"];
const COASTAL_PER_SITE = 5;

const coastalOutcomes: UnitOutcome[] = [];
for (const siteId of COASTAL_SITES) {
  const fullSiteId = `${country.country.id}:${siteId}`;
  const coLevel = levelData("combat_outpost", 1);
  const startHourIndex = 0; // nothing else queued ahead of it
  for (const resource of RESOURCE_KEYS) {
    const cost = coLevel.cost[resource];
    if (cost) costAdjustments[startHourIndex][resource] -= cost;
  }
  const coBuildHours = Math.ceil(
    (coLevel.build_time.days ?? 0) * 24 + (coLevel.build_time.hours ?? 0) + (coLevel.build_time.minutes ?? 0) / 60
  );
  const upkeep = coLevel.daily_upkeep;
  if (upkeep) {
    for (let h = coBuildHours; h < hoursToSimulate; h++) {
      for (const resource of RESOURCE_KEYS) {
        const amount = upkeep[resource];
        if (amount) costAdjustments[h][resource] -= amount / 24;
      }
    }
  }

  const unit = catalog.units.coastal_battery;
  const level1 = unit.levels["1"];
  const mobData = level1.mobilisation[doctrine] ?? level1.mobilisation[unit.doctrine[0]];
  const baseHours = (mobData.time.days ?? 0) * 24 + (mobData.time.hours ?? 0) + (mobData.time.minutes ?? 0) / 60;

  let hour = coBuildHours;
  const jobStartHour = hour;
  let achieved = 0;
  for (let i = 0; i < COASTAL_PER_SITE; i++) {
    const day = Math.max(1, Math.floor((hour + simulationStartAbsoluteHour) / 24) + 1);
    const moralePct = baselineHomelandMoraleOnDay(day);
    const duration = Math.ceil(effectiveDurationFromMorale(baseHours, moralePct));
    if (hour + duration > deadlineHour) break;

    const cost = mobData.cost;
    for (const resource of RESOURCE_KEYS) {
      const amount = cost[resource];
      if (amount) costAdjustments[hour][resource] -= amount;
    }
    const completionHour = hour + duration;
    const upkeepU = level1.daily_upkeep[doctrine]?.cost ?? level1.daily_upkeep[unit.doctrine[0]]?.cost;
    if (upkeepU) {
      for (let h = completionHour; h < hoursToSimulate; h++) {
        for (const resource of RESOURCE_KEYS) {
          const amount = upkeepU[resource];
          if (amount) costAdjustments[h][resource] -= amount / 24;
        }
      }
    }
    hour = completionHour;
    achieved++;
  }
  coastalOutcomes.push({
    cityId: siteId,
    unitId: "coastal_battery",
    demanded: COASTAL_PER_SITE,
    achieved,
    jobReadyHour: coBuildHours,
    jobStartHour,
    jobEndHour: hour,
  });
}

// --- Aggregate production + costs ---
const hourly = Array.from({ length: hoursToSimulate }, (_, index) => {
  const production = zero();
  for (const resource of RESOURCE_KEYS) {
    production[resource] += citySim.perHourAggregate[index]?.production[resource] ?? 0;
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
console.log(`\nBaseline: recruiting_office L1 then arms_industry L1 in every city.`);

const allOutcomes = [...outcomes, ...coastalOutcomes];
console.log("\nJob-level feasibility:");
console.table(
  allOutcomes.map(o => ({
    site: o.cityId,
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
for (const o of allOutcomes) {
  const entry = demandTotals.get(o.unitId) ?? { demanded: 0, achieved: 0 };
  entry.demanded += o.demanded;
  entry.achieved += o.achieved;
  demandTotals.set(o.unitId, entry);
}
console.log("\nDemand totals:");
console.table(
  Array.from(demandTotals.entries()).map(([unitId, v]) => ({
    unit: unitId,
    demanded: v.demanded,
    achieved: v.achieved,
    feasible: v.achieved >= v.demanded ? "YES" : "NO",
  }))
);

console.log("\nTruce-end resource balance for Cuba:");
console.table([
  { label: "Starting Balance", ...startingBalance },
  { label: "Net Production (incl. all infra + mob costs/upkeep)", ...totals },
  { label: "Ending Balance (truce end)", ...endingBalance },
]);

console.log("\nLowest running balance at any point during the truce:");
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
  .warn { color: #cf222e; font-weight: bold; }
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

  type TimelineRow = { kind: "build" | "mob"; sortKey: number; startHour: number; endHour: number; label: string };
  const rows: TimelineRow[] = [];

  if (segs) {
    for (const [buildingId, segments] of Object.entries(segs) as Array<[
      "naval_base" | "arms_industry" | "recruiting_office" | "air_base" | "underground_bunkers",
      typeof segs["naval_base"]
    ]>) {
      for (const segment of segments) {
        const startHour = Math.floor(segment.startMinute / 60) - simulationStartAbsoluteHour;
        const endHour = Math.ceil(segment.endMinute / 60) - simulationStartAbsoluteHour;
        rows.push({ kind: "build", sortKey: segment.startMinute, startHour, endHour, label: `${buildingId} L${segment.fromLevel}→L${segment.toLevel}` });
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
    ? (ECO_TAIL_SEQUENCE[city.id] ? "eco-optimised (no military role)" : "baseline eco only")
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

const coastalSiteHtml = COASTAL_SITES.map(siteId => {
  const o = coastalOutcomes.find(x => x.cityId === siteId)!;
  const tableRows = [
    { step: "build", start: fmtHour(0), end: fmtHour(o.jobReadyHour), action: "combat_outpost L0→L1" },
    { step: "mobilise", start: fmtHour(o.jobStartHour), end: fmtHour(o.jobEndHour), action: `mobilise coastal_battery × ${o.achieved}${o.achieved < o.demanded ? ` (of ${o.demanded} demanded — SHORT)` : ""}` },
  ];
  return `<h3>${escapeHtml(siteId)} <span class="note">(non-resource province)</span></h3>\n` + renderTable(tableRows, ["step", "start", "end", "action"]);
}).join("\n");

// Earliest hour any site actually needs each researched unit — used to sanity-check
// that the hour-0 research cost booking doesn't distort feasibility (research isn't
// tied to any one city/site).
const earliestNeedByUnit = new Map<string, number>();
for (const o of [...outcomes, ...coastalOutcomes]) {
  const prev = earliestNeedByUnit.get(o.unitId);
  if (prev === undefined || o.jobReadyHour < prev) earliestNeedByUnit.set(o.unitId, o.jobReadyHour);
}

const researchHtml = `<table><thead><tr><th>unit</th><th>start</th><th>end</th><th>first site needs it by</th>${RESOURCE_KEYS.map(r => `<th>${r}</th>`).join("")}</tr></thead><tbody>`
  + [...researchRows].sort((a, b) => a.startHour - b.startHour).map(r => {
    const deadline = earliestNeedByUnit.get(r.unitId);
    return `<tr><td>${escapeHtml(r.unitId)}</td><td>${fmtHour(r.startHour)}</td><td>${fmtHour(r.endHour)}</td><td>${deadline !== undefined ? fmtHour(deadline) : "—"}</td>${RESOURCE_KEYS.map(res => {
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

const grossTotal = Object.fromEntries(
  RESOURCE_KEYS.map(r => [r, citySim.perHourPerCity.reduce((sum, result) => sum + (result.production[r] ?? 0), 0)])
) as Record<Resource, number>;
const allCostsTotal = Object.fromEntries(RESOURCE_KEYS.map(r => [r, totals[r] - grossTotal[r]])) as Record<Resource, number>;

const ecoVsCostHtml = `<table><thead>${resourceTableHeader()}</thead><tbody>`
  + resourceRow("Gross eco production (all cities, over 8 days)", grossTotal)
  + resourceRow("− Infra + mobilisation + research costs + upkeep", allCostsTotal)
  + resourceRow("= Net production", totals, "total")
  + `</tbody></table>\n`;

const balanceHtml = `<table><thead>${resourceTableHeader()}</thead><tbody>`
  + resourceRow("Starting Balance", startingBalance)
  + resourceRow("Net Production (infra + mob + research, all costs & upkeep)", totals)
  + resourceRow("Ending Balance (truce end)", endingBalance, "total")
  + `</tbody></table>\n`;

const minBalanceHtml = `<table><thead>${resourceTableHeader()}</thead><tbody>`
  + resourceRow("Minimum running balance", minBalance)
  + `<tr><td>Hour reached</td>${RESOURCE_KEYS.map(r => `<td>${fmtHour(minBalanceHour[r])}</td>`).join("")}</tr>`
  + `</tbody></table>\n`;

const deficitWarning = (endingBalance.electronics < 0 || endingBalance.components < 0)
  ? `<p class="warn">⚠ This plan is NOT resource-feasible as configured: electronics ends at ${fmt(Math.round(endingBalance.electronics))} and components at ${fmt(Math.round(endingBalance.components))}. Cuba has only one electronics city (Camagüey) and one components city (Cienfuegos) — mobilisation demand for Cruiser/Elite Frigate/ASW Helicopter far outstrips what those two cities can produce, and reassigning which city hosts which job doesn't help (production isn't gated by mob-queue activity in this engine).</p>`
  : "";

const html = buildHtml(
  `Cuba Build Profile — ${scenario.id}`,
  `
<h1>Cuba — Build Profile (${scenario.name})</h1>
<p class="meta">Doctrine: ${escapeHtml(doctrine)} · Truce: ${truceDays} days (${hoursToSimulate}h) · Speed: ${escapeHtml(scenario.speed)}</p>
<p class="meta">Baseline: recruiting_office L1 then arms_industry L1 in every city. Naval demands (Naval Veteran, Elite Frigate, Cruiser) split across Santiago de Cuba + Cienfuegos (2 cities). Havana (starts with air_base 1) hosts both helicopter units. Coastal Battery mobilised 5 per site across 3 individual non-resource provinces. Camagüey runs pure eco (arms_industry -> L5, relocate_headquarters, underground_bunkers) instead of naval duty. Santa Clara stays idle.</p>
${deficitWarning}

<h2>Demand totals</h2>
${demandTotalsHtml}

<h2>Eco income vs. costs (country-wide)</h2>
${ecoVsCostHtml}

<h2>Truce-end resource balance (Cuba)</h2>
${balanceHtml}

<h2>Lowest running balance during the truce</h2>
${minBalanceHtml}

<h2>Research (L1, one-time per unit type — country-wide, not per-site)</h2>
<p class="note">Costs booked at hour 0 for simplicity (research isn't tied to any one city/province site).</p>
${researchHtml}

<h2>City build &amp; mobilisation plans</h2>
${cityBuildPlanHtml}

<h2>Coastal Battery sites (individual provinces)</h2>
${coastalSiteHtml}
`
);

const outDir = path.resolve("tmp");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "cuba-build-profile.html");
fs.writeFileSync(outPath, html, "utf8");
console.log(`\n→ wrote ${outPath}`);
