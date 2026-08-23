import assert from "node:assert/strict";
import test from "node:test";

import type { EcoPlanCountryData } from "../db/eco-run-reader.js";
import { buildEcoPlanCountryPage, type NotionBlock } from "./eco-plan-blocks.js";

function baseCountry(overrides: Partial<EcoPlanCountryData> = {}): EcoPlanCountryData {
  return {
    runId: 1,
    countryId: "norway",
    countryName: "Norway",
    doctrine: "western",
    status: "homeland",
    captureDay: null,
    truceDays: 28,
    beamWidth: 50,
    cities: [],
    provinceCohorts: [],
    countryProduction: {},
    countryBuildCost: {},
    ...overrides,
  };
}

function plainText(block: NotionBlock, key: string): string {
  const rt = (block[key] as { rich_text: Array<{ text: { content: string } }> }).rich_text;
  return rt.map(r => r.text.content).join("");
}

function tableRows(block: NotionBlock): NotionBlock[] {
  return (block.table as { children: NotionBlock[] }).children;
}

function cellText(row: NotionBlock, colIndex: number): string {
  const cells = (row.table_row as { cells: Array<Array<{ text: { content: string } }>> }).cells;
  return cells[colIndex].map(c => c.text.content).join("");
}

test("marks the capital city with a star and bold annotation", () => {
  const page = buildEcoPlanCountryPage(
    baseCountry({
      cities: [
        {
          cityId: "oslo",
          cityName: "Oslo",
          resource: "fuel",
          capital: true,
          lastBuildCompletionAbsHour: 100,
          explored: 10,
          buildActions: [],
          production: {},
          buildCost: {},
        },
      ],
    })
  );

  const cityTable = page.blocks.find(b => b.type === "table" && (b.table as any).table_width === 5)!;
  const rows = tableRows(cityTable);
  assert.equal(cellText(rows[1], 0), "★ Oslo");
  const cells = (rows[1].table_row as any).cells as Array<Array<{ annotations?: { bold?: boolean } }>>;
  assert.equal(cells[0][0].annotations?.bold, true);
});

test("formats a build action's absolute hour as day/hour", () => {
  const page = buildEcoPlanCountryPage(
    baseCountry({
      cities: [
        {
          cityId: "oslo",
          cityName: "Oslo",
          resource: "fuel",
          capital: false,
          lastBuildCompletionAbsHour: null,
          explored: 1,
          buildActions: [{ stepNo: 1, buildingId: "arms_industry", targetLevel: 2, startAbsHour: 29 }],
          production: {},
          buildCost: {},
        },
      ],
    })
  );

  const cityTable = page.blocks.find(b => b.type === "table" && (b.table as any).table_width === 5)!;
  const rows = tableRows(cityTable);
  // absHour 29 -> day 2 (floor(29/24)+1), hour 5 (29 % 24)
  assert.equal(cellText(rows[1], 2), "L2 arms industry @ day 2 h05");
  assert.equal(cellText(rows[1], 3), "—");
});

test("renders the occupied capture-day banner only for occupied countries", () => {
  const homelandPage = buildEcoPlanCountryPage(baseCountry({ status: "homeland" }));
  const occupiedPage = buildEcoPlanCountryPage(baseCountry({ status: "occupied", captureDay: 4 }));

  const hasBanner = (blocks: NotionBlock[]) =>
    blocks.some(b => b.type === "paragraph" && plainText(b, "paragraph").startsWith("Occupied: captured day"));

  assert.equal(hasBanner(homelandPage.blocks), false);
  assert.equal(hasBanner(occupiedPage.blocks), true);
  assert.ok(plainText(occupiedPage.blocks[1], "paragraph").includes("captured day 4"));
});

test("production summary totals row uses countryProduction, not a resummed value", () => {
  const page = buildEcoPlanCountryPage(
    baseCountry({
      cities: [
        {
          cityId: "oslo",
          cityName: "Oslo",
          resource: "fuel",
          capital: true,
          lastBuildCompletionAbsHour: null,
          explored: 1,
          buildActions: [],
          production: { fuel: 100 },
          buildCost: {},
        },
      ],
      // Deliberately not the naive sum of city production, to prove the
      // renderer trusts the already-computed country total rather than
      // resumming city rows itself.
      countryProduction: { fuel: 999 },
    })
  );

  const summaryTable = page.blocks.find(b => b.type === "table" && (b.table as any).table_width === 9)!;
  const rows = tableRows(summaryTable);
  const totalRow = rows[rows.length - 1];
  assert.equal(cellText(totalRow, 0), "Total (cities + provinces)");
  assert.equal(cellText(totalRow, 4), "999"); // fuel is the 3rd resource column (City, Resource, supplies, components, fuel, ...)
});

test("skips build-cost rows for cities/cohorts with zero cost", () => {
  const page = buildEcoPlanCountryPage(
    baseCountry({
      cities: [
        {
          cityId: "oslo",
          cityName: "Oslo",
          resource: "fuel",
          capital: true,
          lastBuildCompletionAbsHour: null,
          explored: 1,
          buildActions: [],
          production: {},
          buildCost: {}, // no cost at all -> should not get its own row
        },
      ],
      countryBuildCost: {},
    })
  );

  const costTable = page.blocks[page.blocks.length - 1];
  const rows = tableRows(costTable);
  // Just the header + the Total row; Oslo is skipped.
  assert.equal(rows.length, 2);
  assert.equal(cellText(rows[1], 0), "Total");
});
