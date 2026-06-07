import type { Resource, StartingPopulation } from "../../core/constants.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import {
  scheduleBuildSegments,
  type BuildAction,
  type BuildingId,
} from "../orchestration/build-order-timeline.js";
import { buildCountryHourlyResourceBalanceTable } from "../reporting/country-resource-balance.js";
import { simulateBuildOrder, type CityState } from "../simulation/build-order-sim.js";
import type { BuildingsFile } from "../../schemas/building-schema.js";
import type { Country } from "../../schemas/country-schema.js";
import type { ScenarioFile } from "../../schemas/scenario-schema.js";

const RESOURCE_KEYS: Resource[] = [
  "supplies",
  "components",
  "fuel",
  "rares",
  "electronics",
  "cash",
  "manpower",
];

export type EcoCandidateBuildingId =
  | "air_base"
  | "arms_industry"
  | "military_hospital"
  | "naval_base"
  | "relocate_headquarters"
  | "underground_bunkers";

const ECO_CANDIDATE_BUILDINGS: readonly EcoCandidateBuildingId[] = [
  "arms_industry",
  "air_base",
  "military_hospital",
  "underground_bunkers",
  "naval_base",
  "relocate_headquarters",
];

export type CityEcoBeamConfig = {
  hoursToSimulate: number;
  beamWidth: number;
  topN: number;
  /** Extra buildings to allow in the search (e.g. relocate_headquarters for specific city) */
  extraBuildingsForCity?: Record<string, EcoCandidateBuildingId[]>;
};

export type CityEcoCandidate = {
  sequenceLines: string[];
  timedOrderLines: string[];
  /** Timed build actions for this sequence */
  actions: BuildAction[];
  deltaResource: number;
  deltaCash: number;
  deltaManpower: number;
  endResource: number;
  endCash: number;
  endManpower: number;
};

export type CityEcoResult = {
  cityId: string;
  cityName: string;
  resource: string;
  capital: boolean;
  /** Building levels at scenario start (from country YAML) */
  startingLevels: Partial<Record<EcoCandidateBuildingId, number>>;
  /** Best eco build actions (timed, relative hours from scenario start) */
  bestActions: BuildAction[];
  /**
   * Building levels from eco builds completed at or before absHour.
   * Includes starting levels. absHour is absolute game hour (same scale as
   * scenarioStartAbsoluteHour + elapsed hours).
   */
  buildingLevelsAtAbsHour: (absHour: number) => Partial<Record<EcoCandidateBuildingId, number>>;
  /** Hour at which the last eco build action completes (absolute) */
  lastEcoBuildCompletionAbsHour: number;
  endingBalances: Record<Resource, number>;
  top: CityEcoCandidate[];
  explored: number;
};

export type CountryEcoBeamResult = {
  scenarioAbsHour: number;
  cityResults: CityEcoResult[];
};

function zeroResources(): Record<Resource, number> {
  return { supplies: 0, components: 0, fuel: 0, rares: 0, electronics: 0, cash: 0, manpower: 0 };
}

function levelData(buildings: BuildingsFile, buildingId: EcoCandidateBuildingId, level: number) {
  const data = buildings.buildings[buildingId]?.levels[String(level) as "1" | "2" | "3" | "4" | "5"];
  if (!data) throw new Error(`Missing ${buildingId} level ${level}`);
  return data;
}

function maxDefinedLevel(buildings: BuildingsFile, buildingId: EcoCandidateBuildingId): number {
  const levels = Object.entries(buildings.buildings[buildingId]?.levels ?? {})
    .filter(([, value]) => value)
    .map(([level]) => Number(level));
  return levels.length > 0 ? Math.max(...levels) : 0;
}

function buildCityState(country: Country, city: Country["cities"][number]): CityState {
  return {
    cityId: `${country.country.id}:${city.id}`,
    countryId: country.country.id,
    capital: city.capital,
    resource: city.resource,
    startPop: city.population as StartingPopulation,
    cityStatus: "homeland",
    buildings: {
      army_base: 0,
      air_base: city.starting.air_base,
      annex_city: 0,
      arms_industry: 0,
      combat_outpost: 0,
      local_industry: 0,
      military_hospital: 0,
      naval_base: city.starting.naval_base,
      recruiting_office: 0,
      relocate_headquarters: 0,
      underground_bunkers: city.starting.underground_bunkers,
    },
  };
}

function startingLevelsForCity(city: Country["cities"][number]): Partial<Record<EcoCandidateBuildingId, number>> {
  const levels: Partial<Record<EcoCandidateBuildingId, number>> = {};
  if (city.starting.air_base > 0) levels.air_base = city.starting.air_base;
  if (city.starting.naval_base > 0) levels.naval_base = city.starting.naval_base;
  if (city.starting.underground_bunkers > 0) levels.underground_bunkers = city.starting.underground_bunkers;
  return levels;
}

function buildingPoolForCity(
  country: Country,
  city: Country["cities"][number],
  buildings: BuildingsFile,
  extraBuildingsForCity?: Record<string, EcoCandidateBuildingId[]>
): EcoCandidateBuildingId[] {
  const cityId = `${country.country.id}:${city.id}`;
  const pool: EcoCandidateBuildingId[] = ["arms_industry", "air_base", "military_hospital", "underground_bunkers"];
  if (city.starting.naval_base >= 1) pool.push("naval_base");
  const extras = extraBuildingsForCity?.[cityId] ?? [];
  for (const extra of extras) {
    if (!pool.includes(extra) && maxDefinedLevel(buildings, extra) > 0) pool.push(extra);
  }
  return pool;
}

function cityLevelForTokens(
  city: Country["cities"][number],
  tokens: Array<{ buildingId: EcoCandidateBuildingId }>,
  buildingId: EcoCandidateBuildingId
): number {
  const startingLevel =
    buildingId === "air_base" ? city.starting.air_base :
    buildingId === "naval_base" ? city.starting.naval_base :
    buildingId === "underground_bunkers" ? city.starting.underground_bunkers : 0;
  return startingLevel + tokens.filter(t => t.buildingId === buildingId).length;
}

function hourlyDeltasFromCountryTable(
  table: ReturnType<typeof buildCountryHourlyResourceBalanceTable>
): Array<Record<Resource, number>> {
  return table.rows.map((row, index) => {
    const previous = index === 0 ? undefined : table.rows[index - 1]?.balances;
    const delta = zeroResources();
    for (const resource of RESOURCE_KEYS) {
      delta[resource] = (row.balances[resource] ?? 0) - (previous?.[resource] ?? 0);
    }
    return delta;
  });
}

function tokenSequenceKey(tokens: Array<{ buildingId: EcoCandidateBuildingId; targetLevel: number }>): string {
  return tokens.map(t => `${t.buildingId}:${t.targetLevel}`).join("|");
}

function formatSequenceLines(tokens: Array<{ buildingId: EcoCandidateBuildingId; targetLevel: number }>): string[] {
  if (tokens.length === 0) return ["(no build)"];
  return tokens.map((t, i) => `${i + 1}. ${t.buildingId} level ${t.targetLevel}`);
}

function formatTimedOrderLines(actions: BuildAction[]): string[] {
  if (actions.length === 0) return ["(no build)"];
  return actions.map((a, i) => `${i + 1}. ${a.buildingId} level ${a.targetLevel} at hour ${a.startHour ?? 0}`);
}

function beamSearchCity(
  country: Country,
  city: Country["cities"][number],
  scenario: ScenarioFile,
  buildings: BuildingsFile,
  baselineCountryHourly: Array<Record<Resource, number>>,
  config: CityEcoBeamConfig,
  pool: EcoCandidateBuildingId[]
): CityEcoResult {
  const { hoursToSimulate, beamWidth, topN } = config;
  const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
  const cityState = buildCityState(country, city);
  const startingLevels = startingLevelsForCity(city);

  const baselineCitySimulation = simulateBuildOrder({
    cities: [cityState],
    buildOrder: [],
    buildings,
    scenario,
    hoursToSimulate,
  });

  const otherCountryHourly = baselineCountryHourly.map((countryRow, index) => {
    const row = zeroResources();
    for (const resource of RESOURCE_KEYS) {
      row[resource] = countryRow[resource] - (baselineCitySimulation.perHourAggregate[index]?.production[resource] ?? 0);
    }
    return row;
  });

  type TokenAction = { buildingId: EcoCandidateBuildingId; targetLevel: number };

  type Evaluation = {
    feasible: boolean;
    timedOrder: BuildAction[];
    balancesByHour: Array<Record<Resource, number>>;
    endingBalances: Record<Resource, number>;
    nextFreeRelHour: number;
  };

  function evaluateTimedOrder(timedOrder: BuildAction[]): Evaluation {
    const simulation = simulateBuildOrder({
      cities: [cityState],
      buildOrder: timedOrder,
      buildings,
      scenario,
      hoursToSimulate,
    });

    const segmentsByCity = scheduleBuildSegments({
      cities: [{
        cityId: cityState.cityId,
        countryId: cityState.countryId,
        capital: cityState.capital,
        cityStatus: cityState.cityStatus,
        moraleParams: cityState.moraleParams,
        buildings: cityState.buildings,
      }],
      buildOrder: timedOrder,
      buildings,
      scenario,
    });

    const adjustments = Array.from({ length: hoursToSimulate }, () => zeroResources());
    const segments = segmentsByCity.get(cityState.cityId);

    if (segments) {
      for (const [buildingId, buildingSegments] of Object.entries(segments) as Array<[EcoCandidateBuildingId, (typeof segments)[EcoCandidateBuildingId]]>) {
        for (const segment of buildingSegments) {
          const cost = levelData(buildings, buildingId, segment.toLevel).cost;
          const startHourIndex = Math.floor(segment.startMinute / 60) - scenarioAbsHour;
          if (startHourIndex >= 0 && startHourIndex < hoursToSimulate) {
            for (const resource of RESOURCE_KEYS) {
              adjustments[startHourIndex][resource] -= cost[resource] ?? 0;
            }
          }

          const upkeep = levelData(buildings, buildingId, segment.toLevel).daily_upkeep;
          if (upkeep) {
            const completionHourIndex = Math.ceil(segment.endMinute / 60) - scenarioAbsHour;
            for (let h = completionHourIndex; h < hoursToSimulate; h++) {
              for (const resource of RESOURCE_KEYS) {
                const amount = upkeep[resource];
                if (Number.isFinite(amount)) {
                  adjustments[h][resource] -= Math.floor((amount ?? 0) / 24);
                }
              }
            }
          }
        }
      }
    }

    const balancesByHour: Array<Record<Resource, number>> = [];
    const endingBalances = zeroResources();

    for (let h = 0; h < hoursToSimulate; h++) {
      const previous = balancesByHour[h - 1] ?? zeroResources();
      const balances = zeroResources();
      for (const resource of RESOURCE_KEYS) {
        balances[resource] =
          previous[resource] +
          (simulation.perHourAggregate[h]?.production[resource] ?? 0) +
          (otherCountryHourly[h]?.[resource] ?? 0) +
          adjustments[h][resource];
        endingBalances[resource] = balances[resource];
      }
      balancesByHour.push(balances);
    }

    const lastCompletionAbsHour = segments
      ? Object.values(segments).flatMap(segs => segs).reduce(
          (latest, seg) => Math.max(latest, seg.endMinute / 60),
          scenarioAbsHour
        )
      : scenarioAbsHour;

    return {
      feasible: balancesByHour.every(bal => RESOURCE_KEYS.every(r => bal[r] >= 0)),
      timedOrder,
      balancesByHour,
      endingBalances,
      nextFreeRelHour: lastCompletionAbsHour - scenarioAbsHour,
    };
  }

  const baseline = evaluateTimedOrder([]);

  type RankedSequence = {
    sequenceKey: string;
    sequenceLines: string[];
    timedOrderLines: string[];
    actions: BuildAction[];
    endingBalances: Record<Resource, number>;
    deltaResource: number;
    deltaCash: number;
    deltaManpower: number;
    endResource: number;
    endCash: number;
    endManpower: number;
  };

  function rank(tokens: TokenAction[], evaluation: Evaluation): RankedSequence {
    return {
      sequenceKey: tokenSequenceKey(tokens),
      sequenceLines: formatSequenceLines(tokens),
      timedOrderLines: formatTimedOrderLines(evaluation.timedOrder),
      actions: evaluation.timedOrder,
      endingBalances: evaluation.endingBalances,
      deltaResource: evaluation.endingBalances[city.resource] - baseline.endingBalances[city.resource],
      deltaCash: evaluation.endingBalances.cash - baseline.endingBalances.cash,
      deltaManpower: evaluation.endingBalances.manpower - baseline.endingBalances.manpower,
      endResource: evaluation.endingBalances[city.resource],
      endCash: evaluation.endingBalances.cash,
      endManpower: evaluation.endingBalances.manpower,
    };
  }

  function compareRanked(a: RankedSequence, b: RankedSequence): number {
    return (b.endResource - a.endResource) || a.sequenceKey.localeCompare(b.sequenceKey);
  }

  function nextActions(tokens: TokenAction[]): TokenAction[] {
    return pool.flatMap(buildingId => {
      const currentLevel = cityLevelForTokens(city, tokens, buildingId);
      if (currentLevel >= maxDefinedLevel(buildings, buildingId)) return [];
      return [{ buildingId, targetLevel: currentLevel + 1 }];
    });
  }

  function maxSequenceLength(): number {
    return pool.reduce((sum, buildingId) => {
      return sum + (maxDefinedLevel(buildings, buildingId) - cityLevelForTokens(city, [], buildingId));
    }, 0);
  }

  const cache = new Map<string, Evaluation>();
  cache.set("", baseline);

  function evaluateTokens(tokens: TokenAction[]): Evaluation {
    const key = tokenSequenceKey(tokens);
    const cached = cache.get(key);
    if (cached) return cached;

    let timedOrder: BuildAction[] = [];
    let currentEvaluation = baseline;
    const currentTokens: TokenAction[] = [];

    for (const token of tokens) {
      currentTokens.push(token);
      const prefixKey = tokenSequenceKey(currentTokens);
      const prefixCached = cache.get(prefixKey);
      if (prefixCached) {
        timedOrder = prefixCached.timedOrder;
        currentEvaluation = prefixCached;
        continue;
      }

      const cost = levelData(buildings, token.buildingId, token.targetLevel).cost;
      const minStartHour = Math.ceil(currentEvaluation.nextFreeRelHour);
      let scheduledStartHour: number | undefined;

      for (let h = minStartHour; h < hoursToSimulate; h++) {
        const available = currentEvaluation.balancesByHour[h] ?? zeroResources();
        if (RESOURCE_KEYS.every(resource => available[resource] >= (cost[resource] ?? 0))) {
          scheduledStartHour = h;
          break;
        }
      }

      if (scheduledStartHour === undefined) {
        const failed: Evaluation = {
          feasible: false,
          timedOrder,
          balancesByHour: currentEvaluation.balancesByHour,
          endingBalances: currentEvaluation.endingBalances,
          nextFreeRelHour: currentEvaluation.nextFreeRelHour,
        };
        cache.set(prefixKey, failed);
        return failed;
      }

      timedOrder = [
        ...timedOrder,
        { cityId: cityState.cityId, buildingId: token.buildingId as BuildingId, targetLevel: token.targetLevel, startHour: scheduledStartHour },
      ];
      currentEvaluation = evaluateTimedOrder(timedOrder);
      cache.set(prefixKey, currentEvaluation);
    }

    return currentEvaluation;
  }

  const seen = new Set<string>([""]);
  type CandidatePlan = { tokens: TokenAction[]; evaluation: Evaluation; ranked: RankedSequence };
  let frontier: CandidatePlan[] = [{
    tokens: [],
    evaluation: baseline,
    ranked: rank([], baseline),
  }];
  const allRanked = new Map<string, RankedSequence>();
  const totalDepth = maxSequenceLength();

  for (let depth = 1; depth <= totalDepth; depth++) {
    const candidates = new Map<string, CandidatePlan>();

    for (const plan of frontier) {
      for (const action of nextActions(plan.tokens)) {
        const tokens = [...plan.tokens, action];
        const key = tokenSequenceKey(tokens);
        if (seen.has(key)) continue;
        seen.add(key);

        const evaluation = evaluateTokens(tokens);
        if (!evaluation.feasible) continue;

        const ranked = rank(tokens, evaluation);
        allRanked.set(key, ranked);
        candidates.set(key, { tokens, evaluation, ranked });
      }
    }

    if (candidates.size === 0) break;

    frontier = Array.from(candidates.values())
      .sort((a, b) => compareRanked(a.ranked, b.ranked))
      .slice(0, beamWidth);
  }

  const top = Array.from(allRanked.values()).sort(compareRanked).slice(0, topN);
  const bestActions = top[0]?.actions ?? [];

  // Build segments for best actions so we can answer buildingLevelsAtAbsHour queries
  const bestSegmentsByCity = scheduleBuildSegments({
    cities: [{
      cityId: cityState.cityId,
      countryId: cityState.countryId,
      capital: cityState.capital,
      cityStatus: cityState.cityStatus,
      moraleParams: cityState.moraleParams,
      buildings: cityState.buildings,
    }],
    buildOrder: bestActions,
    buildings,
    scenario,
  });
  const bestSegments = bestSegmentsByCity.get(cityState.cityId);

  const lastEcoBuildCompletionAbsHour = bestSegments
    ? Object.values(bestSegments).flatMap(segs => segs).reduce(
        (latest, seg) => Math.max(latest, seg.endMinute / 60),
        scenarioAbsHour
      )
    : scenarioAbsHour;

  function buildingLevelsAtAbsHour(absHour: number): Partial<Record<EcoCandidateBuildingId, number>> {
    const levels: Partial<Record<EcoCandidateBuildingId, number>> = { ...startingLevels };
    if (!bestSegments) return levels;
    for (const [buildingId, segs] of Object.entries(bestSegments) as Array<[EcoCandidateBuildingId, typeof bestSegments[EcoCandidateBuildingId]]>) {
      for (const seg of segs) {
        if (seg.endMinute / 60 <= absHour) {
          levels[buildingId] = Math.max(levels[buildingId] ?? 0, seg.toLevel);
        }
      }
    }
    return levels;
  }

  return {
    cityId: cityState.cityId,
    cityName: city.name,
    resource: city.resource,
    capital: city.capital ?? false,
    startingLevels,
    bestActions,
    buildingLevelsAtAbsHour,
    lastEcoBuildCompletionAbsHour,
    endingBalances: top[0]?.endingBalances ?? baseline.endingBalances,
    top: top.map(r => ({
      sequenceLines: r.sequenceLines,
      timedOrderLines: r.timedOrderLines,
      actions: r.actions,
      deltaResource: r.deltaResource,
      deltaCash: r.deltaCash,
      deltaManpower: r.deltaManpower,
      endResource: r.endResource,
      endCash: r.endCash,
      endManpower: r.endManpower,
    })),
    explored: seen.size - 1,
  };
}

/**
 * Run the eco city beam search for all (or a filtered subset of) cities in a country.
 * Returns per-city results with best eco build sequence and building-level query function.
 */
export function runCityEcoBeam(
  country: Country,
  scenario: ScenarioFile,
  buildings: BuildingsFile,
  config: CityEcoBeamConfig,
  cityFilter?: string
): CountryEcoBeamResult {
  const { hoursToSimulate } = config;
  const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);

  const baselineCountryTable = buildCountryHourlyResourceBalanceTable(
    country,
    Math.ceil(hoursToSimulate / 24),
    scenario.speed,
    {
      buildingsFile: buildings,
      scenario,
      startingBalances: scenario.starting_balance,
      startAbsoluteHour: scenarioAbsHour,
    }
  );
  const baselineCountryHourly = hourlyDeltasFromCountryTable(baselineCountryTable).slice(0, hoursToSimulate);

  const selectedCities = cityFilter
    ? country.cities.filter(city => city.id === cityFilter)
    : country.cities;

  const cityResults = selectedCities.map(city => {
    const pool = buildingPoolForCity(country, city, buildings, config.extraBuildingsForCity);
    return beamSearchCity(country, city, scenario, buildings, baselineCountryHourly, config, pool);
  });

  return { scenarioAbsHour, cityResults };
}
