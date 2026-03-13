import test from "node:test";
import assert from "node:assert/strict";
import { buildCountryHourlyResourceBalanceTable } from "./country-resource-balance.js";
import { getEconomicBuildingEffectsForLevels } from "../economy/building-modifiers.js";
import { buildHourlyResourceTable } from "../economy/city-production.js";
import { buildTestBuildings } from "../../test-support/buildings-fixture.js";

test("country hourly balance table accumulates balances per resource", () => {
  const buildings = buildTestBuildings();
  const country = {
    version: 1,
    country: {
      id: "testland",
      name: "Testland",
      doctrine: "western",
    },
    cities: [
      {
        id: "alpha",
        name: "Alpha",
        capital: true,
        resource: "supplies",
        population: 5,
        starting: {
          army_base: 1,
          air_base: 0,
          naval_base: 0,
          arms_industry: 0,
          local_industry: 0,
          recruiting_office: 0,
        },
      },
      {
        id: "bravo",
        name: "Bravo",
        capital: false,
        resource: "fuel",
        population: 4,
        starting: {
          army_base: 1,
          air_base: 0,
          naval_base: 0,
          arms_industry: 0,
          local_industry: 0,
          recruiting_office: 0,
        },
      },
    ],
  };

  const table = buildCountryHourlyResourceBalanceTable(country, 1, "4x", {
    buildingsFile: buildings,
    startingBalances: {
      supplies: 100,
      fuel: 50,
    },
  });

  assert.equal(table.rows.length, 24);
  assert.equal(table.rows[0].hour, 1);
  assert.equal(table.rows[0].balances.supplies >= 100, true);
  assert.equal(table.rows[0].balances.fuel >= 50, true);
  assert.equal(table.rows[0].balances.cash > 0, true);
  assert.equal(table.rows[0].balances.manpower > 0, true);
  assert.equal(table.rows[0].balances.components, undefined);
  assert.equal(table.endingBalances.supplies, table.rows[23].balances.supplies);
  assert.equal(table.endingBalances.fuel, table.rows[23].balances.fuel);
  assert.equal(table.endingBalances.cash, table.rows[23].balances.cash);
  assert.equal(table.endingBalances.manpower, table.rows[23].balances.manpower);
});

test("country hourly balance table applies city Arms Industry levels through shared building modifiers", () => {
  const buildings = buildTestBuildings();
  const baseCity = {
    id: "alpha",
    name: "Alpha",
    capital: true,
    resource: "supplies",
    population: 5,
    starting: {
      army_base: 1,
      air_base: 0,
      naval_base: 0,
      arms_industry: 0,
      local_industry: 0,
      recruiting_office: 0,
    },
  };

  const baseCountry = {
    version: 1,
    country: {
      id: "testland",
      name: "Testland",
      doctrine: "western",
    },
    cities: [baseCity],
  };

  const improvedCountry = {
    ...baseCountry,
    cities: [
      {
        ...baseCity,
        starting: { ...baseCity.starting, arms_industry: 1 },
      },
    ],
  };

  const baseTable = buildCountryHourlyResourceBalanceTable(baseCountry, 1, "4x", {
    buildingsFile: buildings,
  });
  const improvedTable = buildCountryHourlyResourceBalanceTable(improvedCountry, 1, "4x", {
    buildingsFile: buildings,
  });
  const effects = getEconomicBuildingEffectsForLevels(buildings, { arms_industry: 1 });
  const suppliesBaseHourly = buildHourlyResourceTable(1, "4x", {
    resource: "supplies",
    startPop: 5,
    moraleParams: { S: 70, T: 90, N: 0, D: 8 },
  });
  const suppliesImprovedHourly = buildHourlyResourceTable(1, "4x", {
    resource: "supplies",
    startPop: 5,
    moraleParams: { S: 70, T: 90, N: 0, D: 8 },
    buildingEffects: effects,
  });
  const cashBaseHourly = buildHourlyResourceTable(1, "4x", {
    resource: "cash",
    startPop: 5,
    moraleParams: { S: 70, T: 90, N: 0, D: 8 },
  });
  const cashImprovedHourly = buildHourlyResourceTable(1, "4x", {
    resource: "cash",
    startPop: 5,
    moraleParams: { S: 70, T: 90, N: 0, D: 8 },
    buildingEffects: effects,
  });

  assert.equal(
    improvedTable.rows[0]?.balances.supplies - baseTable.rows[0]?.balances.supplies,
    suppliesImprovedHourly.rows[0]?.amount - suppliesBaseHourly.rows[0]?.amount
  );
  assert.equal(
    improvedTable.rows[0]?.balances.cash - baseTable.rows[0]?.balances.cash,
    cashImprovedHourly.rows[0]?.amount - cashBaseHourly.rows[0]?.amount
  );
});

test("country hourly balance table includes air and naval base production bonuses", () => {
  const buildings = buildTestBuildings();
  const baseCity = {
    id: "alpha",
    name: "Alpha",
    capital: true,
    resource: "supplies",
    population: 5,
    starting: {
      army_base: 1,
      air_base: 0,
      naval_base: 0,
      arms_industry: 0,
      local_industry: 0,
      recruiting_office: 0,
    },
  };
  const improvedCountry = {
    version: 1,
    country: {
      id: "testland",
      name: "Testland",
      doctrine: "western",
    },
    cities: [
      {
        ...baseCity,
        starting: { ...baseCity.starting, air_base: 1, naval_base: 2 },
      },
    ],
  };

  const baseTable = buildCountryHourlyResourceBalanceTable(
    {
      version: 1,
      country: {
        id: "testland",
        name: "Testland",
        doctrine: "western",
      },
      cities: [baseCity],
    },
    1,
    "4x",
    { buildingsFile: buildings }
  );
  const improvedTable = buildCountryHourlyResourceBalanceTable(improvedCountry, 1, "4x", {
    buildingsFile: buildings,
  });
  const effects = getEconomicBuildingEffectsForLevels(buildings, {
    air_base: 1,
    naval_base: 2,
  });
  const suppliesBaseHourly = buildHourlyResourceTable(1, "4x", {
    resource: "supplies",
    startPop: 5,
    moraleParams: { S: 70, T: 90, N: 0, D: 8 },
  });
  const suppliesImprovedHourly = buildHourlyResourceTable(1, "4x", {
    resource: "supplies",
    startPop: 5,
    moraleParams: { S: 70, T: 90, N: 0, D: 8 },
    buildingEffects: effects,
  });

  assert.equal(
    improvedTable.rows[0]?.balances.supplies - baseTable.rows[0]?.balances.supplies,
    suppliesImprovedHourly.rows[0]?.amount - suppliesBaseHourly.rows[0]?.amount
  );
});

test("country hourly balance table applies scenario city-status multipliers", () => {
  const buildings = buildTestBuildings();
  const country = {
    version: 1,
    country: {
      id: "testland",
      name: "Testland",
      doctrine: "western",
    },
    cities: [
      {
        id: "alpha",
        name: "Alpha",
        capital: true,
        resource: "supplies",
        population: 5,
        starting: {
          army_base: 1,
          air_base: 0,
          naval_base: 0,
          arms_industry: 0,
          local_industry: 0,
          recruiting_office: 0,
        },
      },
    ],
  };
  const homeland = buildCountryHourlyResourceBalanceTable(country, 1, "4x", {
    buildingsFile: buildings,
  });
  const occupied = buildCountryHourlyResourceBalanceTable(country, 1, "4x", {
    buildingsFile: buildings,
    scenario: {
      schema_version: 1,
      domain: "scenario",
      id: "test_scenario",
      name: "Test Scenario",
      start: { day: 1, hour: 0 },
      speed: "4x",
      starting_balance: {
        supplies: 0,
        components: 0,
        fuel: 0,
        rares: 0,
        electronics: 0,
        cash: 0,
        manpower: 0,
      },
      city_statuses: {
        testland: {
          alpha: "occupied",
        },
      },
    },
  });

  assert.ok(homeland.rows[0].balances.supplies > occupied.rows[0].balances.supplies);
});

test("country hourly balance table can move headquarters morale bonus via scenario override", () => {
  const buildings = buildTestBuildings();
  const country = {
    version: 1,
    country: {
      id: "testland",
      name: "Testland",
      doctrine: "western",
    },
    cities: [
      {
        id: "capital",
        name: "Capital",
        capital: true,
        resource: "supplies",
        population: 5,
        starting: {
          army_base: 1,
          air_base: 0,
          naval_base: 0,
          arms_industry: 0,
          local_industry: 0,
          recruiting_office: 0,
        },
      },
      {
        id: "other",
        name: "Other",
        capital: false,
        resource: "fuel",
        population: 4,
        starting: {
          army_base: 1,
          air_base: 0,
          naval_base: 0,
          arms_industry: 0,
          local_industry: 0,
          recruiting_office: 0,
        },
      },
    ],
  };

  const baseline = buildCountryHourlyResourceBalanceTable(country, 2, "4x", {
    buildingsFile: buildings,
  });
  const relocated = buildCountryHourlyResourceBalanceTable(country, 2, "4x", {
    buildingsFile: buildings,
    scenario: {
      schema_version: 1,
      domain: "scenario",
      id: "test_scenario",
      name: "Test Scenario",
      start: { day: 1, hour: 0 },
      speed: "4x",
      starting_balance: {
        supplies: 0,
        components: 0,
        fuel: 0,
        rares: 0,
        electronics: 0,
        cash: 0,
        manpower: 0,
      },
      headquarters_city_by_country: {
        testland: "other",
      },
    },
  });

  assert.ok(
    baseline.rows[baseline.rows.length - 1].balances.supplies >
      relocated.rows[relocated.rows.length - 1].balances.supplies
  );
});
