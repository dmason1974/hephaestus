import type { Resource } from "../core/constants.js";
import type { ForceOverrunDemandData, ForceProjectionCityData, ForceProjectionCountryData, ForceResearchSegmentData } from "../db/force-run-reader.js";

/**
 * Pure DB-data -> Notion-block transform for a Unit 2 (force projection) country
 * report. Section layout/wording mirrors iron-fp-<country>.html exactly (Research
 * Plan, City Mob Build Plans as one continuously-numbered step table per city,
 * Mobilisation Cost Summary, Province Mobilisation Detail as a nested list) — as
 * Notion API block objects instead of <table> markup, per explicit user
 * direction. The one deliberate difference: research slots stay as separate
 * tables (not one combined table with a Slot column — also explicit user
 * direction) rather than iron-fp's single table. This is the PLAIN force
 * projection (computeCountryForceProjection, unmodified, no eco credit, no beam
 * search) — same computation iron-fp-plan.ts runs, not a tailored eco build. No
 * network calls, no re-simulation: every value already lives in the rows
 * `readForceProjectionCountryData` returned.
 *
 * A "Deadline Overrun" section (below) was added when this was ported onto a
 * fixed engine that now correctly splits mobilisation cost/duration by the
 * research level actually attained (see country-force-projection.ts's
 * splitMobBatchByLevel/overrunDemands) — a plan can have every city allocated
 * (cities.length > 0) and still be `infeasible` because a mob step's real
 * mobEnd lands after the deadline, which the original "INFEASIBLE — no cities
 * allocated" wording didn't distinguish.
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

export type ForceProjectionNotionPage = {
  title: string;
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

function heading3(text: string): NotionBlock {
  return { object: "block", type: "heading_3", heading_3: { rich_text: rt(text) } };
}

function paragraph(runs: NotionRichText[]): NotionBlock {
  return { object: "block", type: "paragraph", paragraph: { rich_text: runs } };
}

function bulletedListItem(runs: NotionRichText[], children?: NotionBlock[]): NotionBlock {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: runs, ...(children ? { children } : {}) },
  };
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

function unitLabel(unitId: string): string {
  return unitId.replaceAll("_", " ");
}

function cityLabel(city: ForceProjectionCityData): string {
  return city.capital ? `★ ${city.cityName}` : city.cityName;
}

function resourceRow(
  label: string,
  amounts: Partial<Record<Resource, number>>,
  opts?: { bold?: boolean }
): NotionRichText[][] {
  const cells = [rt(label, opts?.bold ? { bold: true } : undefined)];
  for (const r of RESOURCE_COLUMNS) {
    const v = amounts[r] ?? 0;
    cells.push(rt(v === 0 ? "—" : fmt(Math.round(v))));
  }
  return cells;
}

// ── Research Plan — one table per slot, stacked ─────────────────────────────

function researchSlotTable(segments: ForceResearchSegmentData[]): NotionBlock {
  const rows = segments
    .slice()
    .sort((a, b) => a.startAbsHour - b.startAbsHour)
    .map(s => [
      rt(unitLabel(s.unitId)),
      rt(String(s.level)),
      rt(fmtAbsHour(s.startAbsHour)),
      rt(fmtAbsHour(s.endAbsHourExclusive)),
      rt(`${Math.round(s.durationHours)}h`),
    ]);
  return table(["Unit", "Level", "Start", "Complete", "Duration"], rows);
}

/** One table per research slot, stacked — the two slots run independently and
 *  in parallel in-game, so a single time-ordered table interleaving them reads
 *  worse than two separate tables a reader can scan on their own (explicit user
 *  direction — iron-fp-*.html uses one combined table with a Slot column). */
function researchPlanBlocks(data: ForceProjectionCountryData): NotionBlock[] {
  const slotNumbers = [...new Set(data.researchSegments.map(s => s.slot))].sort((a, b) => a - b);
  if (slotNumbers.length <= 1) return [researchSlotTable(data.researchSegments)];

  return slotNumbers.flatMap(slotNum => [
    heading3(`Slot ${slotNum}`),
    researchSlotTable(data.researchSegments.filter(s => s.slot === slotNum)),
  ]);
}

// ── City Mob Build Plans — one continuously-numbered step table per city ───

function mobQueueSummary(city: ForceProjectionCityData): string {
  const entries = city.slot.mobQueue as Array<{ unitId: string; count: number }>;
  return entries.map(e => `${unitLabel(e.unitId)} ×${e.count}`).join(", ");
}

function cityStepTable(city: ForceProjectionCityData): NotionBlock {
  const rows: NotionRichText[][][] = city.slot.infraSteps.map((s, i) => [
    rt(String(i + 1)),
    rt(`${unitLabel(s.buildingId)} L${s.toLevel}`),
    rt(fmtAbsHour(s.startHour)),
    rt(fmtAbsHour(s.endHour)),
    rt(`${Math.round(s.durH)}h`),
  ]);

  let stepNum = city.slot.infraSteps.length + 1;
  for (const m of city.slot.mobSteps) {
    rows.push([
      rt(String(stepNum++)),
      rt(`${unitLabel(m.unitId)}${m.level !== null ? ` L${m.level}` : ""} mob ×${m.count}`),
      rt(fmtAbsHour(m.startAbsHour)),
      rt(fmtAbsHour(m.endAbsHour)),
      rt(`${Math.round(m.durationHours)}h`),
    ]);
  }

  return table(["#", "step", "start", "complete", "dur"], rows);
}

/** One section (h3 + intro + flip-point line + numbered step table) per city
 *  with an assigned force demand. */
function cityMobBuildPlanBlocks(data: ForceProjectionCountryData): NotionBlock[] {
  return data.cities.flatMap(city => [
    heading3(`${cityLabel(city)} — RO L${city.slot.roLevel}`),
    paragraph(rt(`Infra: ${unitLabel(city.slot.primaryUnitId)} requirements · Mob queue: ${mobQueueSummary(city)}`)),
    paragraph(rt(`Flip point: ${fmtAbsHour(city.slot.flipPointAbsHour)} — eco until then, military infra after.`, { bold: true })),
    cityStepTable(city),
  ]);
}

// ── Deadline Overrun — a mob step whose real mobEnd lands after the deadline ─

function overrunDemandTable(overruns: ForceOverrunDemandData[]): NotionBlock {
  const rows = overruns
    .slice()
    .sort((a, b) => a.mobEndAbsHour - b.mobEndAbsHour)
    .map(d => [
      rt(unitLabel(d.unitId)),
      rt(d.cityId.replaceAll("_", " ")),
      rt(String(d.level)),
      rt(fmtAbsHour(d.mobEndAbsHour)),
      rt(fmtAbsHour(d.deadlineAbsHour)),
      rt(`${Math.round(d.mobEndAbsHour - d.deadlineAbsHour)}h`),
    ]);
  return table(["Unit", "City", "Level", "Mob End", "Deadline", "Overrun"], rows);
}

/** Shown whenever overrunDemands is non-empty — a plan can have every city
 *  allocated and still be infeasible for this reason alone, distinct from the
 *  "fold-in found no feasible city allocation" case. */
function deadlineOverrunBlocks(data: ForceProjectionCountryData): NotionBlock[] {
  return [
    heading2("⚠ Deadline Overrun"),
    paragraph(
      rt(
        "These mob steps' real, research-level-split mobEnd lands after the truce deadline — the actual explanation for this plan being infeasible, distinct from a fold-in failure (every city below IS allocated). This surfaces a real gap rather than fixing it — see the joint cost-optimizing scheduler follow-up.",
        { color: "red" }
      )
    ),
    overrunDemandTable(data.overrunDemands),
  ];
}

// ── Mobilisation Cost Summary ───────────────────────────────────────────────

function costSummaryTable(data: ForceProjectionCountryData): NotionBlock {
  const buckets: Array<[string, Partial<Record<Resource, number>>]> = [
    ["Infra (RO)", data.costs.infraRo],
    ["Infra (buildings)", data.costs.infraBuildings],
    ["Mobilisation", data.costs.mobilisation],
    ["Upkeep (stepped)", data.costs.upkeep],
    ["Province mob + mercenary_outpost", data.costs.provinceMobilisation],
    ["Province upkeep (flat)", data.costs.provinceUpkeep],
    ["Total", data.costs.total],
  ];
  const rows = buckets.map(([label, cost], i) => resourceRow(label, cost, { bold: i === buckets.length - 1 }));
  return table(["", ...RESOURCE_COLUMNS], rows);
}

// ── Province Mobilisation Detail — nested bullet list ───────────────────────

function provinceMobBlocks(data: ForceProjectionCountryData): NotionBlock[] {
  return data.provinceMobResults.map(r => {
    const trancheItems = r.tranches.map(t => {
      const tr = t as {
        level: number;
        count: number;
        mobStartHour: number;
        mobilisationEarliestHour: number;
        completionHour: number;
        mobilizationDurationHours: number;
      };
      return bulletedListItem(
        rt(`L${tr.level}: ${tr.count} units — research floor hour ${tr.mobilisationEarliestHour}, mobilise ${tr.mobStartHour}→${tr.completionHour} (${tr.mobilizationDurationHours}h)`)
      );
    });
    return bulletedListItem(
      rt(`${unitLabel(r.unitId)} × ${r.count} — mercenary_outpost → L${r.mercenaryOutpostRequiredLevel} (${r.mercenaryOutpostBuildHours}h cumulative), capacity ${r.provinceCount} provinces`),
      trancheItems
    );
  });
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function buildForceProjectionCountryPage(data: ForceProjectionCountryData): ForceProjectionNotionPage {
  const blocks: NotionBlock[] = [];

  const infoRuns: NotionRichText[] = [
    ...rt(`Doctrine: ${data.doctrine} · Status: `),
    ...rt(data.status, data.status === "occupied" ? { bold: true, color: "red" } : undefined),
    ...rt(` · Truce: ${data.truceDays} days · morale ${Math.round(data.moraleAtStart)}%→${Math.round(data.moraleAtDeadline)}%`),
  ];
  blocks.push(paragraph(infoRuns));
  blocks.push(
    paragraph(
      rt(
        "Runs the existing Unit 2 force-projection engine unmodified (computeCountryForceProjection) — city count and RO level per demand are exactly what that function decides. Not eco-credited: infra chains build from scratch."
      )
    )
  );

  if (data.reason === "no_demands") {
    blocks.push(paragraph(rt(`No demands defined for ${data.countryId}.`, { color: "gray" })));
    return { title: `Force Projection — ${data.countryName}`, icon: data.status === "occupied" ? "🚩" : "🎯", blocks };
  }
  if (data.reason === "no_active_demands") {
    blocks.push(paragraph(rt(`No city-mobilised demands for ${data.countryId}.`, { color: "gray" })));
    return { title: `Force Projection — ${data.countryName}`, icon: data.status === "occupied" ? "🚩" : "🎯", blocks };
  }

  if (data.researchSegments.length > 0) {
    blocks.push(heading2("Research Plan"));
    blocks.push(
      paragraph(rt("L1 JIT (ends at deadline − mob window); L2+ JIT from deadline. Priority: impact × demand count."))
    );
    blocks.push(...researchPlanBlocks(data));
  }

  blocks.push(heading2("City Mob Build Plans"));
  blocks.push(
    paragraph(
      rt(
        "One section per city. Mob queue ordered ascending by total burden (upkeepRate × count) — lowest-burden batches mob first, highest-burden mobs last (JIT). Infra built JIT for primary (heaviest) unit; compatible lighter units absorb into same city. RO L1 built first to start manpower income."
      )
    )
  );
  if (data.cities.length === 0) {
    blocks.push(paragraph(rt("INFEASIBLE — fold-in found no feasible city allocation.", { bold: true, color: "red" })));
  } else {
    blocks.push(...cityMobBuildPlanBlocks(data));
  }

  if (data.overrunDemands.length > 0) {
    blocks.push(...deadlineOverrunBlocks(data));
  }

  blocks.push(heading2("Mobilisation Cost Summary"));
  if (data.demandLabels.length > 0) {
    blocks.push(paragraph(rt(data.demandLabels.join(" · "))));
  }
  if (data.infeasible && data.cities.length === 0) {
    blocks.push(paragraph(rt("INFEASIBLE — no cities allocated.", { bold: true, color: "red" })));
  } else if (data.infeasible) {
    blocks.push(paragraph(rt("INFEASIBLE — see ⚠ Deadline Overrun above; costs below are still reported for whatever was allocated.", { bold: true, color: "red" })));
    blocks.push(costSummaryTable(data));
  } else {
    blocks.push(costSummaryTable(data));
  }

  if (data.provinceMobResults.length > 0) {
    blocks.push(heading2("Province Mobilisation Detail"));
    blocks.push(...provinceMobBlocks(data));
  }

  if (data.missingDataDemands.length > 0) {
    const demands = data.missingDataDemands as Array<{ unitId: string; count: number }>;
    blocks.push(heading2("⚠ Missing Doctrine Data"));
    blocks.push(...demands.map(d => bulletedListItem(rt(`${d.unitId} × ${d.count} — no ${data.doctrine} mobilisation data`, { color: "red" }))));
  }

  if (data.skippedDemands.length > 0) {
    const demands = data.skippedDemands as Array<{ unitId: string; count: number }>;
    blocks.push(heading2("Skipped Demands"));
    blocks.push(...demands.map(d => bulletedListItem(rt(`${d.unitId} × ${d.count} — launcher platform (zero mob cost)`, { color: "gray" }))));
  }

  return {
    title: `Force Projection — ${data.countryName}`,
    icon: data.status === "occupied" ? "🚩" : "🎯",
    blocks,
  };
}
