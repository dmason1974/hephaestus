import type { CityStatus, GameSpeed, Resource } from "../../core/constants.js";
import type { BuildingsFile } from "../../schemas/building-schema.js";
import type { Country } from "../../schemas/country-schema.js";
import type { ScenarioStartLike } from "../../core/time.js";
import { buildProvinceCohortsFromCountry, type ProvinceCohort } from "../provinces/province-cohorts.js";
import {
  simulateProvinceBuildOrder,
  type ProvinceBuildAction,
} from "../simulation/province-build-order-sim.js";

export type ProvinceEcoBeamResult = {
  cohortId: string;
  resource: Exclude<Resource, "cash" | "manpower"> | null;
  provinceCount: number;
  bestActions: ProvinceBuildAction[];
  totalProduction: Record<Resource, number>;
  hourlyCohortProduction: Array<Record<Resource, number>>;
  totalEcoBuildCost: Partial<Record<Resource, number>>;
};

type CandidateSequence = Array<{ buildingId: "combat_outpost" | "local_industry"; targetLevel: number }>;

function generateCandidateSequences(): CandidateSequence[] {
  const co1 = { buildingId: "combat_outpost" as const, targetLevel: 1 };
  const li1 = { buildingId: "local_industry" as const, targetLevel: 1 };
  const li2 = { buildingId: "local_industry" as const, targetLevel: 2 };
  const li3 = { buildingId: "local_industry" as const, targetLevel: 3 };

  return [
    [],
    [co1],
    [li1],
    [co1, li1],
    [li1, co1],
    [li1, li2],
    [co1, li1, li2],
    [li1, co1, li2],
    [li1, li2, co1],
    [li1, li2, li3],
    [co1, li1, li2, li3],
    [li1, co1, li2, li3],
    [li1, li2, co1, li3],
    [li1, li2, li3, co1],
  ];
}

const CANDIDATE_SEQUENCES = generateCandidateSequences();

function scoreCohort(
  cohort: ProvinceCohort,
  total: Record<Resource, number>
): number {
  if (cohort.resource !== null) return total[cohort.resource];
  return total.manpower;
}

function buildCostForSequence(
  buildings: BuildingsFile,
  sequence: CandidateSequence
): Partial<Record<Resource, number>> {
  const cost: Partial<Record<Resource, number>> = {};
  for (const step of sequence) {
    const levelDef = buildings.buildings[step.buildingId]?.levels[String(step.targetLevel)];
    if (!levelDef) continue;
    for (const [resource, amount] of Object.entries(levelDef.cost ?? {})) {
      if (amount) {
        cost[resource as Resource] = (cost[resource as Resource] ?? 0) + amount;
      }
    }
  }
  return cost;
}

function zeroResources(): Record<Resource, number> {
  return { supplies: 0, components: 0, fuel: 0, rares: 0, electronics: 0, cash: 0, manpower: 0 };
}

function evaluateCohort(
  cohort: ProvinceCohort,
  sequence: CandidateSequence,
  buildings: BuildingsFile,
  scenario: ScenarioStartLike & { speed: GameSpeed },
  hoursToSimulate: number,
  cityStatus: CityStatus
): { total: Record<Resource, number>; hourly: Array<Record<Resource, number>> } {
  const actions: ProvinceBuildAction[] = sequence.map(step => ({
    provinceId: cohort.provinceId,
    buildingId: step.buildingId,
    targetLevel: step.targetLevel,
  }));

  const result = simulateProvinceBuildOrder({
    provinces: [{ ...cohort, cityStatus }],
    buildOrder: actions,
    buildings,
    scenario,
    hoursToSimulate,
  });

  const total = zeroResources();
  const hourly: Array<Record<Resource, number>> = [];

  for (const row of result.perHourAggregate) {
    const h: Record<Resource, number> = zeroResources();
    for (const r of Object.keys(row.production) as Resource[]) {
      total[r] += row.production[r];
      h[r] = row.production[r];
    }
    hourly.push(h);
  }

  return { total, hourly };
}

export function runProvinceEcoBeam(
  country: Country,
  scenario: ScenarioStartLike & { speed: GameSpeed },
  buildings: BuildingsFile,
  opts: { hoursToSimulate: number; cityStatus?: CityStatus }
): ProvinceEcoBeamResult[] {
  const cohorts = buildProvinceCohortsFromCountry(country);
  if (cohorts.length === 0) return [];

  const cityStatus = opts.cityStatus ?? "homeland";
  const results: ProvinceEcoBeamResult[] = [];

  for (const cohort of cohorts) {
    let bestScore = -Infinity;
    let bestSequence: CandidateSequence = [];
    let bestTotal = zeroResources();
    let bestHourly: Array<Record<Resource, number>> = [];

    for (const sequence of CANDIDATE_SEQUENCES) {
      const { total, hourly } = evaluateCohort(
        cohort,
        sequence,
        buildings,
        scenario,
        opts.hoursToSimulate,
        cityStatus
      );
      const score = scoreCohort(cohort, total);
      if (score > bestScore) {
        bestScore = score;
        bestSequence = sequence;
        bestTotal = total;
        bestHourly = hourly;
      }
    }

    results.push({
      cohortId: cohort.cohortId,
      resource: cohort.resource,
      provinceCount: cohort.totalProvinceCount,
      bestActions: bestSequence.map(step => ({
        provinceId: cohort.provinceId,
        buildingId: step.buildingId,
        targetLevel: step.targetLevel,
      })),
      totalProduction: bestTotal,
      hourlyCohortProduction: bestHourly,
      totalEcoBuildCost: buildCostForSequence(buildings, bestSequence),
    });
  }

  return results;
}
