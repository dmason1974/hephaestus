import type { Resource } from "../../core/constants.js";
import { POOLED_RESOURCES } from "../../core/constants.js";
import type { UnitCatalog } from "../../schemas/unit-schema.js";
import type { CityEcoResult } from "../eco/city-eco-beam.js";
import { zeroResourceMap, addResourcesInto, scaleResources, cityIncomeThroughFlip, cityFullEcoIncome } from "../eco/city-eco-income.js";
import {
  computeSteppedUpkeep,
  getLevelSteps,
  type CountryForceProjectionResult,
} from "../optimization/country-force-projection.js";
import { calculateMobilizationCost } from "../optimization/cost-calculator.js";
import type { ResourceCost } from "../optimization/types.js";
import type { GarrisonUpkeepResult } from "../optimization/garrison-upkeep.js";

export type CountryResourceBalanceInput = {
  countryId: string;
  countryName: string;
  doctrine: string;
  catalog: UnitCatalog;
  scenarioAbsHour: number;
  hoursToSimulate: number;
  /** Unit 1 output for this country. cityId is PREFIXED (`${countryId}:${cityId}`). */
  cityResults: CityEcoResult[];
  /** Unit 2 output for this country. cityId inside citySlots is BARE. */
  forceProjection: CountryForceProjectionResult;
  /** Σ city.totalEcoBuildCost across cityResults. */
  ecoBuildCost: ResourceCost;
  /** {} for occupied countries. */
  garrisonUpkeep: GarrisonUpkeepResult;
  /** {} for occupied/AI countries. */
  startingBalance: Partial<Record<Resource, number>>;
};

export type CountryResourceBalance = {
  countryId: string;
  countryName: string;
  ecoIncome: Record<Resource, number>;
  startingBalance: Record<Resource, number>;
  ecoBuildCost: Record<Resource, number>;
  forceCosts: Record<Resource, number>;
  garrisonUpkeep: Record<Resource, number>;
  netBalance: Record<Resource, number>;
  manpowerNetBalance: number;
  /** Per-hour resource delta (income minus costs), index 0 = scenarioAbsHour.
   *  Costs are allocated at the hour they are incurred (infra at step completion,
   *  mobilisation at batch start) except upkeep, which uses a continuous L1-rate
   *  approximation rather than the exact stepped (auto-upgrade-aware) rate used in
   *  `forceCosts` — so the cumulative sum of this array will not exactly match
   *  `netBalance` at the final hour. Good enough to detect a mid-window dip; not
   *  a substitute for the totals-based balance sheet. */
  hourlyNetFlow: Array<Record<Resource, number>>;
};

function bareCityId(prefixedOrBareId: string): string {
  const idx = prefixedOrBareId.indexOf(":");
  return idx === -1 ? prefixedOrBareId : prefixedOrBareId.slice(idx + 1);
}

function clampIndex(relHour: number, hoursToSimulate: number): number {
  return Math.max(0, Math.min(Math.round(relHour), hoursToSimulate - 1));
}

export function computeCountryResourceBalance(input: CountryResourceBalanceInput): CountryResourceBalance {
  const {
    countryId, countryName, doctrine, catalog, scenarioAbsHour, hoursToSimulate,
    cityResults, forceProjection, ecoBuildCost, garrisonUpkeep, startingBalance,
  } = input;

  // Bare cityId → flip rel-hour, built from Unit 2's city slots.
  const cityFlipRelHours = new Map<string, number>();
  for (const slot of forceProjection.citySlots) {
    cityFlipRelHours.set(slot.cityId, slot.flipPointAbsHour - scenarioAbsHour);
  }

  // ── Eco income (flip-truncated per city) ──────────────────────────────────
  const ecoIncome = zeroResourceMap();
  for (const city of cityResults) {
    const flipRelHour = cityFlipRelHours.get(bareCityId(city.cityId));
    const contribution = flipRelHour !== undefined
      ? cityIncomeThroughFlip(city, Math.max(0, flipRelHour), hoursToSimulate)
      : cityFullEcoIncome(city);
    addResourcesInto(ecoIncome, contribution);
  }

  const startingBalanceFull = zeroResourceMap();
  addResourcesInto(startingBalanceFull, startingBalance);

  const ecoBuildCostFull = zeroResourceMap();
  addResourcesInto(ecoBuildCostFull, ecoBuildCost);

  const forceCostsFull = zeroResourceMap();
  addResourcesInto(forceCostsFull, forceProjection.costs.total);

  const garrisonUpkeepFull = zeroResourceMap();
  addResourcesInto(garrisonUpkeepFull, garrisonUpkeep.totalUpkeep);

  const netBalance = zeroResourceMap();
  for (const r of Object.keys(netBalance) as Resource[]) {
    netBalance[r] = ecoIncome[r] + startingBalanceFull[r] - ecoBuildCostFull[r] - forceCostsFull[r] - garrisonUpkeepFull[r];
  }

  // ── Hourly net flow (for coalition-level cash-flow minima) ────────────────
  const hourlyNetFlow: Array<Record<Resource, number>> = Array.from({ length: hoursToSimulate }, () => zeroResourceMap());

  // Income: per-hour, capped at the flip-hour flat rate for military cities.
  for (const city of cityResults) {
    const flipRelHour = cityFlipRelHours.get(bareCityId(city.cityId));
    const flipIndex = flipRelHour !== undefined ? Math.max(0, Math.round(flipRelHour)) : Infinity;
    const flatRate = flipIndex < hoursToSimulate
      ? (city.hourlyCityProduction[Math.max(0, flipIndex - 1)] ?? zeroResourceMap())
      : null;
    for (let h = 0; h < hoursToSimulate; h++) {
      const prod = h < flipIndex ? (city.hourlyCityProduction[h] ?? zeroResourceMap()) : (flatRate ?? zeroResourceMap());
      addResourcesInto(hourlyNetFlow[h], prod);
    }
  }

  // Eco build cost: conservative single lump deduction at hour 0.
  for (const r of Object.keys(zeroResourceMap()) as Resource[]) {
    hourlyNetFlow[0][r] -= ecoBuildCostFull[r];
  }

  // Infra costs: deducted at each step's START hour (queued buildings spend
  // their resources when the build starts, not when it completes) — both the
  // guaranteed work pulled into the idle eco window (ecoBackfillSteps) and the
  // post-flip military chain (infraSteps).
  for (const slot of forceProjection.citySlots) {
    for (const step of [...slot.ecoBackfillSteps, ...slot.infraSteps]) {
      const idx = clampIndex(step.startHour - scenarioAbsHour, hoursToSimulate);
      for (const [r, amount] of Object.entries(step.cost)) {
        if (amount) hourlyNetFlow[idx][r as Resource] -= amount;
      }
    }
  }

  // Mobilisation costs: a batch of N units is N separate per-unit payments,
  // each deducted as that unit starts mobilising — not one lump sum for the
  // whole batch at batch start. Upkeep reuses computeSteppedUpkeep (the same
  // event-based, research-level-aware integration result.costs.upkeep is
  // built from) rather than a flat-level-1 approximation — it only returns a
  // cumulative total for a given deadline, so per-hour charges are derived by
  // calling it at each hour and differencing consecutive totals. Known
  // simplification: treats each mob step's count as `count` individual 1-unit
  // events (unitsPerEvent=1) — exact for non-batch units; batch units (e.g.
  // warheads, batchSize>1) would need unitsPerEvent from the original demand
  // classification, not available from CityForceProjectionSlot alone.
  for (const slot of forceProjection.citySlots) {
    for (const entry of slot.mobSteps) {
      if (entry.count <= 0) continue;
      const perUnitHours = (entry.endAbsHour - entry.startAbsHour) / entry.count;

      let perUnitCost: ResourceCost = {};
      try {
        perUnitCost = calculateMobilizationCost(entry.unitId, 1, 1, catalog, doctrine);
      } catch {
        // missing doctrine/level data — skip
      }

      for (let i = 0; i < entry.count; i++) {
        const unitStartAbsHour = entry.startAbsHour + i * perUnitHours;
        const mobIdx = clampIndex(unitStartAbsHour - scenarioAbsHour, hoursToSimulate);
        for (const [r, amount] of Object.entries(perUnitCost)) {
          if (amount) hourlyNetFlow[mobIdx][r as Resource] -= amount;
        }
      }

      const levelSteps = getLevelSteps(entry.unitId, forceProjection.researchSegments);
      const startRelHour = clampIndex(entry.startAbsHour - scenarioAbsHour, hoursToSimulate);
      let prevCumulative: ResourceCost = {};
      for (let h = startRelHour; h < hoursToSimulate; h++) {
        let cumulative: ResourceCost = {};
        try {
          cumulative = computeSteppedUpkeep(
            entry.unitId,
            doctrine,
            entry.startAbsHour,
            entry.count,
            1,
            perUnitHours,
            scenarioAbsHour + h + 1,
            levelSteps,
            catalog
          );
        } catch {
          // missing doctrine/level data — skip
        }
        for (const [r, amount] of Object.entries(cumulative)) {
          const delta = (amount ?? 0) - (prevCumulative[r as Resource] ?? 0);
          if (delta) hourlyNetFlow[h][r as Resource] -= delta;
        }
        prevCumulative = cumulative;
      }
    }
  }

  // Province-mobilised demands: mercenary_outpost build cost lands at scenario
  // start; each unit_limit-gated tranche (e.g. commando: 5 at L1, 5 more at L2,
  // 2 more at L3) lumps its own mobilisation cost at its own completion and
  // pays its own continuous upkeep after — tranches complete at different
  // hours and levels, so they're walked individually rather than using the
  // aggregate result fields.
  for (const result of forceProjection.provinceMobResults) {
    const outpostIdx = clampIndex(0, hoursToSimulate);
    for (const [r, amount] of Object.entries(result.mercenaryOutpostBuildCost)) {
      if (amount) hourlyNetFlow[outpostIdx][r as Resource] -= amount;
    }
    for (const tranche of result.tranches) {
      const idx = clampIndex(tranche.completionHour, hoursToSimulate);
      for (const [r, amount] of Object.entries(tranche.mobilizationCost)) {
        if (amount) hourlyNetFlow[idx][r as Resource] -= amount;
      }
      let dailyUpkeep: ResourceCost = {};
      try {
        dailyUpkeep = calculateDailyUpkeep(result.unitId, tranche.level, catalog, doctrine);
      } catch {
        // missing doctrine/level data — skip
      }
      const hourlyUpkeep = scaleResources(dailyUpkeep, tranche.count / 24);
      const startH = clampIndex(tranche.completionHour, hoursToSimulate);
      for (let h = startH; h < hoursToSimulate; h++) {
        addResourcesInto(hourlyNetFlow[h], scaleResources(hourlyUpkeep, -1));
      }
    }
  }

  // Garrison upkeep: continuous from scenario start to disband hour.
  if (garrisonUpkeep.hours > 0) {
    const hourlyRate = scaleResources(garrisonUpkeep.totalUpkeep, 1 / garrisonUpkeep.hours);
    const disbandIdx = clampIndex(garrisonUpkeep.hours, hoursToSimulate);
    for (let h = 0; h < disbandIdx; h++) {
      addResourcesInto(hourlyNetFlow[h], scaleResources(hourlyRate, -1));
    }
  }

  // Starting balance is seeded at the coalition level (hour 0), not here.

  return {
    countryId,
    countryName,
    ecoIncome,
    startingBalance: startingBalanceFull,
    ecoBuildCost: ecoBuildCostFull,
    forceCosts: forceCostsFull,
    garrisonUpkeep: garrisonUpkeepFull,
    netBalance,
    manpowerNetBalance: netBalance.manpower,
    hourlyNetFlow,
  };
}

export type ResourceMinimum = { resource: Resource; hour: number; value: number };

export type CoalitionResourceBalance = {
  countries: CountryResourceBalance[];
  pooledStartingBalance: Record<Resource, number>;
  pooledEcoIncome: Record<Resource, number>;
  pooledCosts: Record<Resource, number>;
  netPooledBalance: Record<Resource, number>;
  resourceMinima: ResourceMinimum[];
  perCountryManpower: Array<{ countryId: string; countryName: string; manpowerNetBalance: number }>;
};

export function computeCoalitionResourceBalance(countries: CountryResourceBalance[]): CoalitionResourceBalance {
  const pooledStartingBalance = zeroResourceMap();
  const pooledEcoIncome = zeroResourceMap();
  const pooledCosts = zeroResourceMap();
  const netPooledBalance = zeroResourceMap();

  for (const c of countries) {
    for (const r of POOLED_RESOURCES) {
      pooledStartingBalance[r] += c.startingBalance[r];
      pooledEcoIncome[r] += c.ecoIncome[r];
      pooledCosts[r] += c.ecoBuildCost[r] + c.forceCosts[r] + c.garrisonUpkeep[r];
      netPooledBalance[r] += c.netBalance[r];
    }
  }

  // ── Hourly cash-flow minima (pooled resources only) ───────────────────────
  const hoursToSimulate = Math.max(0, ...countries.map(c => c.hourlyNetFlow.length));
  const running = zeroResourceMap();
  for (const r of POOLED_RESOURCES) running[r] = pooledStartingBalance[r];

  const minima = new Map<Resource, ResourceMinimum>();
  for (const r of POOLED_RESOURCES) minima.set(r, { resource: r, hour: 0, value: running[r] });

  for (let h = 0; h < hoursToSimulate; h++) {
    for (const c of countries) {
      const flow = c.hourlyNetFlow[h];
      if (!flow) continue;
      for (const r of POOLED_RESOURCES) running[r] += flow[r];
    }
    for (const r of POOLED_RESOURCES) {
      const cur = minima.get(r)!;
      if (running[r] < cur.value) minima.set(r, { resource: r, hour: h, value: running[r] });
    }
  }

  const perCountryManpower = countries.map(c => ({
    countryId: c.countryId,
    countryName: c.countryName,
    manpowerNetBalance: c.manpowerNetBalance,
  }));

  return {
    countries,
    pooledStartingBalance,
    pooledEcoIncome,
    pooledCosts,
    netPooledBalance,
    resourceMinima: POOLED_RESOURCES.map(r => minima.get(r)!),
    perCountryManpower,
  };
}
