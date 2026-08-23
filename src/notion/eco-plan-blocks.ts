import type { Resource } from "../core/constants.js";
import type { EcoPlanCityData, EcoPlanCountryData, EcoPlanProvinceCohortData } from "../db/eco-run-reader.js";

/**
 * Pure DB-data -> Notion-block transform for a Unit 1 eco-plan country report.
 * Mirrors the pre-Postgres HTML sink's section layout and content exactly
 * (city build sequences, province build sequences, production summary, build
 * costs) — just as Notion API block objects instead of <table> markup. No
 * network calls, no re-simulation: every value here already lives in the rows
 * `readEcoPlanCountryData` returned.
 */

const RESOURCE_COLUMNS: Resource[] = [
  "supplies",
  "components",
  "fuel",
  "rares",
  "electronics",
  "cash",
  "manpower",
];

export type NotionRichText = {
  type: "text";
  text: { content: string };
  annotations?: Partial<{
    bold: boolean;
    italic: boolean;
    strikethrough: boolean;
    underline: boolean;
    code: boolean;
    color: string;
  }>;
};

export type NotionBlock = Record<string, unknown>;

export type EcoPlanNotionPage = {
  title: string;
  /** Notion page icon (emoji). */
  icon: string;
  blocks: NotionBlock[];
};

function rt(content: string, opts?: { bold?: boolean; color?: string }): NotionRichText[] {
  if (content === "") return [];
  const richText: NotionRichText = { type: "text", text: { content } };
  if (opts?.bold || opts?.color) {
    richText.annotations = {
      ...(opts.bold ? { bold: true } : {}),
      ...(opts.color ? { color: opts.color } : {}),
    };
  }
  return [richText];
}

function heading2(text: string): NotionBlock {
  return { object: "block", type: "heading_2", heading_2: { rich_text: rt(text) } };
}

function paragraph(runs: NotionRichText[]): NotionBlock {
  return { object: "block", type: "paragraph", paragraph: { rich_text: runs } };
}

function tableRow(cells: NotionRichText[][]): NotionBlock {
  return { object: "block", type: "table_row", table_row: { cells } };
}

function table(headerRow: string[], bodyRows: NotionRichText[][][]): NotionBlock {
  return {
    object: "block",
    type: "table",
    table: {
      table_width: headerRow.length,
      has_column_header: true,
      has_row_header: false,
      children: [tableRow(headerRow.map(h => rt(h, { bold: true }))), ...bodyRows.map(tableRow)],
    },
  };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtAbsHour(absHour: number): string {
  const day = Math.floor(absHour / 24) + 1;
  const hour = Math.floor(absHour % 24);
  return `day ${day} h${String(hour).padStart(2, "0")}`;
}

function buildingLabel(buildingId: string): string {
  return buildingId.replaceAll("_", " ");
}

function fmtAction(action: { buildingId: string; targetLevel: number; startAbsHour: number | null }): string {
  const when = action.startAbsHour === null ? "unknown" : fmtAbsHour(action.startAbsHour);
  return `L${action.targetLevel} ${buildingLabel(action.buildingId)} @ ${when}`;
}

function cityLabel(city: EcoPlanCityData): string {
  return city.capital ? `★ ${city.cityName}` : city.cityName;
}

function cohortLabel(cohortId: string): string {
  const idx = cohortId.indexOf(":");
  return idx === -1 ? cohortId : cohortId.slice(idx + 1);
}

function cityBuildPlansTable(cities: EcoPlanCityData[]): NotionBlock {
  const rows = cities.map(city => {
    const sequence = city.buildActions.length === 0 ? "(no builds)" : city.buildActions.map(fmtAction).join("\n");
    const lastBuild = city.lastBuildCompletionAbsHour === null ? "—" : fmtAbsHour(city.lastBuildCompletionAbsHour);
    return [
      rt(cityLabel(city), city.capital ? { bold: true } : undefined),
      rt(city.resource),
      rt(sequence),
      rt(lastBuild),
      rt(String(city.explored)),
    ];
  });
  return table(["City", "Resource", "Eco Build Sequence", "Last build completes", "Explored"], rows);
}

function provinceBuildPlansTable(cohorts: EcoPlanProvinceCohortData[]): NotionBlock {
  const rows = cohorts.map(cohort => {
    const sequence =
      cohort.buildSequence.length === 0
        ? "(no builds)"
        : cohort.buildSequence.map(a => `L${a.targetLevel} ${buildingLabel(a.buildingId)}`).join(" → ");
    return [
      rt(cohortLabel(cohort.cohortId)),
      rt(cohort.resource ?? "—"),
      rt(String(cohort.provinceCount)),
      rt(sequence),
    ];
  });
  return table(["Cohort", "Resource", "Provinces", "Eco Build Sequence"], rows);
}

function resourceRow(
  label: string,
  resource: string,
  amounts: Partial<Record<Resource, number>>,
  opts?: { bold?: boolean; label2Only?: boolean }
): NotionRichText[][] {
  const cells = [rt(label, opts?.bold ? { bold: true } : undefined), rt(resource)];
  for (const r of RESOURCE_COLUMNS) cells.push(rt(fmt(Math.round(amounts[r] ?? 0))));
  return cells;
}

function productionSummaryTable(data: EcoPlanCountryData): NotionBlock {
  const rows: NotionRichText[][][] = [];
  for (const city of data.cities) rows.push(resourceRow(cityLabel(city), city.resource, city.production));
  for (const cohort of data.provinceCohorts) {
    rows.push(resourceRow(cohortLabel(cohort.cohortId), cohort.resource ?? "—", cohort.production));
  }
  rows.push(resourceRow("Total (cities + provinces)", "", data.countryProduction, { bold: true }));
  return table(["City", "Resource", ...RESOURCE_COLUMNS], rows);
}

function buildCostsTable(data: EcoPlanCountryData): NotionBlock {
  const rows: NotionRichText[][][] = [];
  const hasAnyCost = (amounts: Partial<Record<Resource, number>>) =>
    RESOURCE_COLUMNS.some(r => (amounts[r] ?? 0) > 0);
  for (const city of data.cities) {
    if (!hasAnyCost(city.buildCost)) continue;
    rows.push(resourceRow(cityLabel(city), city.resource, city.buildCost));
  }
  for (const cohort of data.provinceCohorts) {
    if (!hasAnyCost(cohort.buildCost)) continue;
    rows.push(resourceRow(cohortLabel(cohort.cohortId), cohort.resource ?? "—", cohort.buildCost));
  }
  rows.push(resourceRow("Total", "", data.countryBuildCost, { bold: true }));
  return table(["City", "Resource", ...RESOURCE_COLUMNS], rows);
}

export function buildEcoPlanCountryPage(data: EcoPlanCountryData): EcoPlanNotionPage {
  const blocks: NotionBlock[] = [];

  const infoRuns: NotionRichText[] = [
    ...rt(`Doctrine: ${data.doctrine} · Status: `),
    ...rt(data.status, data.status === "occupied" ? { bold: true, color: "red" } : undefined),
    ...rt(
      ` · Truce: ${data.truceDays} days` +
        (data.beamWidth !== null ? ` · Beam width: ${data.beamWidth}` : "")
    ),
  ];
  blocks.push(paragraph(infoRuns));

  if (data.status === "occupied") {
    blocks.push(
      paragraph(
        rt(
          `Occupied: captured day ${data.captureDay ?? 4}; annex_city (18h) is the mandatory first build after capture.`
        )
      )
    );
  }

  blocks.push(heading2("City Eco Build Plans"));
  blocks.push(cityBuildPlansTable(data.cities));

  if (data.provinceCohorts.length > 0) {
    blocks.push(heading2("Province Eco Build Plans"));
    blocks.push(provinceBuildPlansTable(data.provinceCohorts));
  }

  blocks.push(heading2(`City Production Summary (full ${data.truceDays}-day eco window)`));
  blocks.push(
    paragraph(
      rt(
        "Total resource flow per city over the full truce window (gross production; does not net out build costs). Manpower is not pooled."
      )
    )
  );
  blocks.push(productionSummaryTable(data));

  blocks.push(heading2("Eco Build Costs"));
  blocks.push(paragraph(rt("One-time resource costs for all eco builds (deducted from the coalition pool).")));
  blocks.push(buildCostsTable(data));

  return {
    title: `Eco Plan — ${data.countryName}`,
    icon: data.status === "occupied" ? "🚩" : "🏙️",
    blocks,
  };
}
