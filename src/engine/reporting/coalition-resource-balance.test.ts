import assert from "node:assert/strict";
import test from "node:test";

import type { Resource } from "../../core/constants.js";
import type { CityEcoResult } from "../eco/city-eco-beam.js";
import type { CountryForceProjectionResult } from "../optimization/country-force-projection.js";
import type { UnitCatalog } from "../../schemas/unit-schema.js";
import {
  computeCountryResourceBalance,
  computeCoalitionResourceBalance,
  type CountryResourceBalance,
} from "./coalition-resource-balance.js";

const catalog = {} as UnitCatalog;

function zero(): Record<Resource, number> {
  return { supplies: 0, components: 0, fuel: 0, rares: 0, electronics: 0, cash: 0, manpower: 0 };
}

function fakeCity(cityId: string, hourlyRate: number, hours: number): CityEcoResult {
  const hourlyCityProduction = Array.from({ length: hours }, () => ({ ...zero(), supplies: hourlyRate }));
  return { cityId, hourlyCityProduction, totalEcoBuildCost: zero() } as unknown as CityEcoResult;
}

function emptyForceProjection(overrides: Partial<CountryForceProjectionResult> = {}): CountryForceProjectionResult {
  return {
    countryName: "Test",
    moraleAtStart: 70,
    moraleAtDeadline: 93,
    researchSegments: [],
    citySlots: [],
    costs: { infraRo: {}, infraBuildings: {}, mobilisation: {}, upkeep: {}, provinceMobilisation: {}, provinceUpkeep: {}, total: {} },
    provinceMobResults: [],
    demandLabels: [],
    skippedDemands: [],
    infeasible: false,
    ...overrides,
  };
}

test("computeCountryResourceBalance: netBalance = income + startingBalance - costs", () => {
  const result = computeCountryResourceBalance({
    countryId: "testland",
    countryName: "Testland",
    doctrine: "western",
    catalog,
    scenarioAbsHour: 0,
    hoursToSimulate: 5,
    cityResults: [fakeCity("testland:cap", 10, 5)],
    forceProjection: emptyForceProjection({ costs: { infraRo: {}, infraBuildings: {}, mobilisation: {}, upkeep: {}, provinceMobilisation: {}, provinceUpkeep: {}, total: { supplies: 3 } } }),
    ecoBuildCost: { supplies: 5 },
    garrisonUpkeep: { hours: 0, totalUpkeep: {}, units: [] },
    startingBalance: { supplies: 20 },
  });

  // income 50 (5h * 10/h, no flip) + starting 20 - ecoBuild 5 - forceCosts 3 - garrison 0 = 62
  assert.equal(result.ecoIncome.supplies, 50);
  assert.equal(result.netBalance.supplies, 62);
});

test("computeCountryResourceBalance: city present in citySlots is flip-truncated, city absent gets full income", () => {
  const result = computeCountryResourceBalance({
    countryId: "testland",
    countryName: "Testland",
    doctrine: "western",
    catalog,
    scenarioAbsHour: 0,
    hoursToSimulate: 4,
    cityResults: [
      fakeCity("testland:city_a", 10, 4), // present in citySlots, flips at rel hour 2
      fakeCity("testland:city_b", 10, 4), // absent from citySlots — full income
    ],
    forceProjection: emptyForceProjection({
      citySlots: [
        {
          cityId: "city_a",
          roLevel: 1,
          primaryUnitId: "some_unit",
          mobQueue: [],
          infraOpenHour: 2,
          flipPointAbsHour: 2,
          infraSteps: [],
          mobSteps: [],
        },
      ],
    }),
    ecoBuildCost: {},
    garrisonUpkeep: { hours: 0, totalUpkeep: {}, units: [] },
    startingBalance: {},
  });

  // city_a: 2 pre-flip hours @10 = 20, then 2 remaining hours flat @10 = 20 → 40 (same rate, so truncation is a no-op numerically)
  // city_b: full 4h @10 = 40
  assert.equal(result.ecoIncome.supplies, 80);
});

function fakeCountryBalance(overrides: Partial<CountryResourceBalance>): CountryResourceBalance {
  return {
    countryId: "c",
    countryName: "C",
    ecoIncome: zero(),
    startingBalance: zero(),
    ecoBuildCost: zero(),
    forceCosts: zero(),
    garrisonUpkeep: zero(),
    netBalance: zero(),
    manpowerNetBalance: 0,
    hourlyNetFlow: [],
    ...overrides,
  };
}

test("computeCoalitionResourceBalance: occupied country contributes zero starting balance to the pool", () => {
  const homeland = fakeCountryBalance({
    countryId: "homeland_a",
    startingBalance: { ...zero(), supplies: 100 },
  });
  const occupied = fakeCountryBalance({
    countryId: "occupied_b",
    startingBalance: zero(), // caller is responsible for zeroing this for occupied countries
    ecoIncome: { ...zero(), supplies: 50 },
  });

  const coalition = computeCoalitionResourceBalance([homeland, occupied]);
  assert.equal(coalition.pooledStartingBalance.supplies, 100);
  assert.equal(coalition.pooledEcoIncome.supplies, 50);
});

test("computeCoalitionResourceBalance: manpower is excluded from pooledCosts/netPooledBalance", () => {
  const country = fakeCountryBalance({
    manpowerNetBalance: -500,
    netBalance: { ...zero(), manpower: -500, supplies: 10 },
    forceCosts: { ...zero(), manpower: 999 },
  });

  const coalition = computeCoalitionResourceBalance([country]);
  assert.equal(coalition.netPooledBalance.manpower, 0);
  assert.equal(coalition.pooledCosts.manpower, 0);
  assert.equal(coalition.netPooledBalance.supplies, 10);
  assert.equal(coalition.perCountryManpower[0].manpowerNetBalance, -500);
});

test("computeCoalitionResourceBalance: resourceMinima finds a mid-window dip below the end-of-window balance", () => {
  const flow0 = zero();
  const flow1 = { ...zero(), supplies: -80 };
  const flow2 = { ...zero(), supplies: 50 };
  const country = fakeCountryBalance({
    startingBalance: { ...zero(), supplies: 100 },
    hourlyNetFlow: [flow0, flow1, flow2],
  });

  const coalition = computeCoalitionResourceBalance([country]);
  const suppliesMin = coalition.resourceMinima.find(m => m.resource === "supplies")!;

  // running balance: h0 → 100, h1 → 20 (the dip), h2 → 70 (end)
  assert.equal(suppliesMin.hour, 1);
  assert.equal(suppliesMin.value, 20);
});
