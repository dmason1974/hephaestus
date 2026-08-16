// Daily balance projection — parses the already-generated tmp/iron-bp-<country>.html
// files (written by iron-bp-plan.ts) rather than recomputing anything, same "parse,
// don't recompute" precedent as iron-resource-projection.ts. Reconstructs a real
// running balance by prefix-summing each file's embedded per-hour net-flow array
// (id="iron-hourly-net-flow") from its "Starting Balance" row, sampled once per day,
// so the user can compare a specific day's projected balance/rate against a real
// in-game screenshot.
//
// Two modes:
//   IRON_COUNTRY=<id>              single country, all 7 resources → tmp/iron-db-<id>.html
//   IRON_COUNTRIES=<id1,id2,...>   coalition, pooled 6 resources (hour-aligned sum,
//                                  same approach iron-resource-projection.ts uses for
//                                  its pooled minima) + a per-country manpower table
//                                  (manpower is never pooled) → tmp/iron-db-coalition.html
//
// Optional, either mode: IRON_AT_DAY=<n> IRON_AT_TIME=<HH:MM> adds an exact-hour
// snapshot (fractional-hour interpolated, not day-sampled) alongside the daily table
// — for comparing against a screenshot's exact in-game timestamp rather than the
// nearest day boundary. Printed to stdout as well as embedded in the HTML.
//
// Run via IRON_COUNTRY=italy npm run smoke:iron-daily-balance
//      or IRON_COUNTRIES=italy,south_africa,pakistan,new_zealand npm run smoke:iron-daily-balance
//      or IRON_COUNTRY=italy IRON_AT_DAY=5 IRON_AT_TIME=06:51 npm run smoke:iron-daily-balance
import fs from "node:fs";
import path from "node:path";

import { PER_COUNTRY_RESOURCES, POOLED_RESOURCES, type Resource } from "../../core/constants.js";

const RESOURCE_KEYS: Resource[] = ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"];
// Matches the in-game HUD's resource ordering — used for the single-country table so
// it lines up visually with a screenshot.
const HUD_RESOURCE_ORDER: Resource[] = ["supplies", "components", "fuel", "rares", "electronics", "manpower", "cash"];

const outputDir = process.env.IRON_OUTPUT_DIR ?? "pnth-v-iron-aug26";
const countryEnv = process.env.IRON_COUNTRY?.trim();
const countriesEnv = process.env.IRON_COUNTRIES?.trim();
if (!countryEnv && !countriesEnv) {
  throw new Error(
    "Set IRON_COUNTRY=<id> for a single country or IRON_COUNTRIES=<id1,id2,...> for a coalition aggregate."
  );
}
if (countryEnv && countriesEnv) {
  throw new Error("Set only one of IRON_COUNTRY or IRON_COUNTRIES, not both.");
}

const atDayEnv = process.env.IRON_AT_DAY?.trim();
const atTimeEnv = process.env.IRON_AT_TIME?.trim();
if ((atDayEnv && !atTimeEnv) || (!atDayEnv && atTimeEnv)) {
  throw new Error("Set both IRON_AT_DAY and IRON_AT_TIME together, e.g. IRON_AT_DAY=5 IRON_AT_TIME=06:51.");
}
let targetAbsHour: number | undefined;
let targetLabel: string | undefined;
if (atDayEnv && atTimeEnv) {
  const day = Number(atDayEnv);
  const timeMatch = atTimeEnv.match(/^(\d{1,2}):(\d{2})$/);
  if (!Number.isFinite(day) || !timeMatch) {
    throw new Error(`Invalid IRON_AT_DAY/IRON_AT_TIME: "${atDayEnv}" "${atTimeEnv}" (expected e.g. IRON_AT_DAY=5 IRON_AT_TIME=06:51).`);
  }
  const hh = Number(timeMatch[1]);
  const mm = Number(timeMatch[2]);
  targetAbsHour = (day - 1) * 24 + hh + mm / 60;
  targetLabel = `day ${day} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

// ── Parsing (duplicated from iron-resource-projection.ts — small and self-contained,
// matching this codebase's own established per-script convention in harness/smoke/*.ts) ──

type ResourceBalanceRow = Record<Resource, number>;
type ParsedHourlyNetFlow = { scenarioAbsHour: number; resourceOrder: Resource[]; hours: number[][] };
type ParsedCountry = {
  countryId: string;
  countryName: string;
  feasible: boolean;
  startingBalance?: ResourceBalanceRow;
  hourlyNetFlow?: ParsedHourlyNetFlow;
};

function parseNum(s: string): number {
  const cleaned = s.replace(/,/g, "").trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function zipResources(values: number[]): ResourceBalanceRow {
  const row = {} as ResourceBalanceRow;
  RESOURCE_KEYS.forEach((r, i) => (row[r] = values[i] ?? 0));
  return row;
}

function parseStartingBalance(html: string): ResourceBalanceRow | undefined {
  const sectionMatch = html.match(/<h2>Resource Balance<\/h2>[\s\S]*?<table>([\s\S]*?)<\/table>/);
  if (!sectionMatch) return undefined;
  const m = sectionMatch[1].match(/<tr><td><strong>Starting Balance<\/strong><\/td>((?:<td[^>]*>[^<]*<\/td>){7})<\/tr>/);
  if (!m) return undefined;
  const cellRe = /<td[^>]*>([^<]*)<\/td>/g;
  const values: number[] = [];
  let cm: RegExpExecArray | null;
  while ((cm = cellRe.exec(m[1]))) values.push(parseNum(cm[1]));
  return zipResources(values);
}

function parseHourlyNetFlow(html: string): ParsedHourlyNetFlow | undefined {
  const m = html.match(
    /<script type="application\/json" id="iron-hourly-net-flow" data-scenario-abs-hour="([^"]+)" data-resource-order="([^"]+)">([\s\S]*?)<\/script>/
  );
  if (!m) return undefined;
  return {
    scenarioAbsHour: parseNum(m[1]),
    resourceOrder: m[2].split(",") as Resource[],
    hours: JSON.parse(m[3]) as number[][],
  };
}

function parseCountryFile(countryId: string): ParsedCountry {
  const filePath = path.resolve(`tmp/${outputDir}/build-plans/iron-bp-${countryId}.html`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`${filePath} not found — run IRON_COUNTRY=${countryId} npm run smoke:iron-bp-plan first`);
  }
  const html = fs.readFileSync(filePath, "utf8");
  const nameMatch = html.match(/<h1>([^<]+) — Iron Build Plan<\/h1>/);
  const countryName = nameMatch?.[1]?.trim() ?? countryId;
  const feasible = !html.includes('<p class="infeasible">No feasible city allocation.</p>');
  return {
    countryId,
    countryName,
    feasible,
    startingBalance: feasible ? parseStartingBalance(html) : undefined,
    hourlyNetFlow: parseHourlyNetFlow(html),
  };
}

// ── HTML helpers (copied inline, matching every other harness/smoke/*.ts script) ──

function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function fmtAbsHour(h: number): string {
  const day = Math.floor(h / 24) + 1;
  const hour = Math.floor(h % 24);
  return `day ${day} h${String(hour).padStart(2, "0")}`;
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
  h2 { font-size: 1rem; margin: 1.5rem 0 0.4rem; border-bottom: 1px solid #ccc; }
  table { border-collapse: collapse; margin-bottom: 0.8rem; }
  th, td { border: 1px solid #ccc; padding: 3px 8px; text-align: right; white-space: nowrap; }
  th { background: #f0f0f0; text-align: center; font-size: 11px; }
  td:first-child, th:first-child { text-align: left; }
  .label { color: #666; font-size: 11px; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

// ── Daily prefix-sum walk ────────────────────────────────────────────────────
// deltaAt(h, r) supplies the net delta for relative hour h (0 = scenarioAbsHour) —
// works uniformly for a single country's own parsed array or a pooled per-hour sum
// across countries. Snapshots every 24h, plus a final snapshot at hoursToSimulate if
// it isn't already a multiple of 24. Rate for each row is the average delta/hour over
// the interval to the NEXT snapshot (day-over-day average) — deliberately not the raw
// single-hour delta, which spikes on whatever hour a lumpy one-off build/mob cost
// happens to land; the day-average is a fairer proxy for the game's steady "+X/h" HUD
// figure. The final row has no rate (nothing follows it to average against).

type DailyRow = { label: string; balances: Record<Resource, number>; rate?: Record<Resource, number> };

function computeDailyRows(
  startingBalance: Record<Resource, number>,
  hoursToSimulate: number,
  scenarioAbsHour: number,
  resources: Resource[],
  deltaAt: (h: number, r: Resource) => number
): DailyRow[] {
  const running: Record<Resource, number> = { ...startingBalance };
  const snapshots: Array<{ hour: number; label: string; balances: Record<Resource, number> }> = [];
  for (let h = 0; h <= hoursToSimulate; h++) {
    if (h % 24 === 0 || h === hoursToSimulate) {
      snapshots.push({ hour: h, label: fmtAbsHour(scenarioAbsHour + h), balances: { ...running } });
    }
    if (h === hoursToSimulate) break;
    for (const r of resources) running[r] += deltaAt(h, r);
  }
  return snapshots.map((s, i) => {
    const next = snapshots[i + 1];
    if (!next) return { label: s.label, balances: s.balances };
    const hoursBetween = next.hour - s.hour;
    const rate = {} as Record<Resource, number>;
    for (const r of resources) rate[r] = (next.balances[r] - s.balances[r]) / hoursBetween;
    return { label: s.label, balances: s.balances, rate };
  });
}

// Exact-hour snapshot (fractional-hour interpolated) for comparing against a
// screenshot's precise in-game timestamp rather than the nearest day boundary. Rate
// here is the instantaneous per-hour delta at that hour (not a day-average).
function computeExactSnapshot(
  startingBalance: Record<Resource, number>,
  scenarioAbsHour: number,
  resources: Resource[],
  deltaAt: (h: number, r: Resource) => number,
  targetAbsHour: number
): DailyRow {
  const targetRelHour = Math.max(0, targetAbsHour - scenarioAbsHour);
  const wholeHours = Math.floor(targetRelHour);
  const frac = targetRelHour - wholeHours;
  const running: Record<Resource, number> = { ...startingBalance };
  for (let h = 0; h < wholeHours; h++) {
    for (const r of resources) running[r] += deltaAt(h, r);
  }
  const rate = {} as Record<Resource, number>;
  for (const r of resources) {
    const hourDelta = deltaAt(wholeHours, r);
    running[r] += frac * hourDelta;
    rate[r] = hourDelta;
  }
  return { label: "exact", balances: running, rate };
}

function renderDailyTable(rows: DailyRow[], resources: Resource[], rowLabel = "Day"): string {
  let out = `<table><thead><tr><th>${escapeHtml(rowLabel)}</th>${resources.map(r => `<th>${escapeHtml(r)}</th>`).join("")}</tr></thead><tbody>`;
  for (const row of rows) {
    out += `<tr><td>${escapeHtml(row.label)}</td>`;
    for (const r of resources) {
      const bal = fmt(row.balances[r]);
      if (!row.rate) {
        out += `<td>${bal}</td>`;
        continue;
      }
      const rate = Math.round(row.rate[r]);
      const color = rate < 0 ? "#cf222e" : rate > 0 ? "#1a7f37" : "#666";
      out += `<td>${bal} <span style="color:${color}">(${rate >= 0 ? "+" : ""}${fmt(rate)}/h)</span></td>`;
    }
    out += `</tr>`;
  }
  out += `</tbody></table>\n`;
  return out;
}

// ── Single-country mode ──────────────────────────────────────────────────────

if (countryEnv) {
  const parsed = parseCountryFile(countryEnv);
  if (!parsed.feasible || !parsed.startingBalance || !parsed.hourlyNetFlow) {
    throw new Error(`${parsed.countryName}: no feasible plan / missing data in tmp/${outputDir}/build-plans/iron-bp-${countryEnv}.html`);
  }
  const { startingBalance, hourlyNetFlow } = parsed;
  const idx = {} as Record<Resource, number>;
  for (const r of RESOURCE_KEYS) idx[r] = hourlyNetFlow.resourceOrder.indexOf(r);

  const rows = computeDailyRows(
    startingBalance,
    hourlyNetFlow.hours.length,
    hourlyNetFlow.scenarioAbsHour,
    RESOURCE_KEYS,
    (h, r) => hourlyNetFlow.hours[h]?.[idx[r]] ?? 0
  );

  let html = `<h1>${escapeHtml(parsed.countryName)} — Daily Balance Projection</h1>\n`;
  html += `<p class="label">Parsed from tmp/${escapeHtml(outputDir)}/build-plans/iron-bp-${escapeHtml(countryEnv)}.html — one row per day (balance sampled at the start of that day), rate is the day-over-day average net hourly rate (matches the in-game "+X/h" HUD figure; excludes single-hour spikes from one-off build/mob costs). Not a live sync of your actual game — this reflects the iron-bp-plan.ts projection, so gaps against a real screenshot may reflect real plan deviations, not just approximation error.</p>\n`;

  if (targetAbsHour !== undefined && targetLabel !== undefined) {
    const snap = computeExactSnapshot(startingBalance, hourlyNetFlow.scenarioAbsHour, RESOURCE_KEYS, (h, r) => hourlyNetFlow.hours[h]?.[idx[r]] ?? 0, targetAbsHour);
    console.log(`Exact snapshot @ ${targetLabel}:`);
    for (const r of HUD_RESOURCE_ORDER) {
      console.log(`  ${r}: ${fmt(snap.balances[r])} (${snap.rate[r] >= 0 ? "+" : ""}${fmt(Math.round(snap.rate[r]))}/h instantaneous)`);
    }
    html += `<h2>Exact Snapshot — ${escapeHtml(targetLabel)}</h2>\n`;
    html += `<p class="label">Exact-hour balance (fractional-hour interpolated), not day-sampled. Rate is the instantaneous per-hour delta at that hour, not a day-average.</p>\n`;
    html += renderDailyTable([{ ...snap, label: targetLabel }], HUD_RESOURCE_ORDER);
  }

  html += renderDailyTable(rows, HUD_RESOURCE_ORDER);

  const outPath = path.resolve(`tmp/${outputDir}/daily-balances/iron-db-${countryEnv}.html`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buildHtml(`Iron Daily Balance — ${parsed.countryName}`, html), "utf8");
  console.log(`→ wrote ${outPath}`);
}

// ── Coalition mode ────────────────────────────────────────────────────────────

if (countriesEnv) {
  const countryIds = countriesEnv.split(",").map(s => s.trim()).filter(Boolean);
  const countries = countryIds.map(parseCountryFile);
  const feasible = countries.filter(c => c.feasible && c.startingBalance && c.hourlyNetFlow);

  const pooledStartingBalance = {} as Record<Resource, number>;
  for (const r of POOLED_RESOURCES) pooledStartingBalance[r] = 0;
  for (const c of feasible) {
    for (const r of POOLED_RESOURCES) pooledStartingBalance[r] += c.startingBalance![r] ?? 0;
  }

  const hoursToSimulate = Math.max(0, ...feasible.map(c => c.hourlyNetFlow!.hours.length));
  const pooledScenarioAbsHour = feasible[0]?.hourlyNetFlow?.scenarioAbsHour ?? 0;
  const resourceIndexByCountry = feasible.map(c => {
    const idx = {} as Record<Resource, number>;
    for (const r of POOLED_RESOURCES) idx[r] = c.hourlyNetFlow!.resourceOrder.indexOf(r);
    return idx;
  });

  const pooledRows = computeDailyRows(pooledStartingBalance, hoursToSimulate, pooledScenarioAbsHour, POOLED_RESOURCES, (h, r) => {
    let delta = 0;
    for (let i = 0; i < feasible.length; i++) {
      const colIdx = resourceIndexByCountry[i][r];
      if (colIdx === -1) continue;
      delta += feasible[i].hourlyNetFlow!.hours[h]?.[colIdx] ?? 0;
    }
    return delta;
  });

  // Per-country manpower (not pooled): each country's own prefix-sum, independently.
  const manpowerResource = PER_COUNTRY_RESOURCES[0]; // "manpower"
  const manpowerRowsByCountry = feasible.map(c => {
    const mIdx = c.hourlyNetFlow!.resourceOrder.indexOf(manpowerResource);
    const rows = computeDailyRows(
      { [manpowerResource]: c.startingBalance![manpowerResource] ?? 0 } as Record<Resource, number>,
      c.hourlyNetFlow!.hours.length,
      c.hourlyNetFlow!.scenarioAbsHour,
      [manpowerResource],
      (h, r) => c.hourlyNetFlow!.hours[h]?.[mIdx] ?? (r === manpowerResource ? 0 : 0)
    );
    return { countryName: c.countryName, rows };
  });

  let html = `<h1>Coalition — Daily Balance Projection</h1>\n`;
  html += `<p class="label">Parsed from tmp/${escapeHtml(outputDir)}/build-plans/iron-bp-&lt;country&gt;.html for: ${escapeHtml(feasible.map(c => c.countryName).join(", "))}${feasible.length < countries.length ? ` (skipped infeasible: ${escapeHtml(countries.filter(c => !feasible.includes(c)).map(c => c.countryName).join(", "))})` : ""}.</p>\n`;

  html += `<h2>Pooled Balance (${POOLED_RESOURCES.join(", ")})</h2>\n`;
  html += `<p class="label">True hour-aligned pooled walk — sums every feasible country's real per-hour net flow before sampling, so countries hitting their own extremes at different points in the window aren't incorrectly stacked together (same approach iron-resource-projection.ts uses for its pooled minima). One row per day; rate is the day-over-day average. Manpower excluded (not pooled — see the per-country table below).</p>\n`;
  html += renderDailyTable(pooledRows, POOLED_RESOURCES);

  html += `<h2>Per-Country Manpower (not pooled)</h2>\n`;
  html += `<p class="label">Manpower is never shared across countries — each column is that country's own independent running balance.</p>\n`;
  const dayLabels = manpowerRowsByCountry[0]?.rows.map(r => r.label) ?? [];
  const manpowerTableRows = dayLabels.map((label, i) => {
    const row: Record<string, unknown> = { day: label };
    for (const c of manpowerRowsByCountry) {
      const r = c.rows[i];
      if (!r) {
        row[c.countryName] = "—";
        continue;
      }
      const bal = fmt(r.balances[manpowerResource]);
      row[c.countryName] = r.rate ? `${bal} (${r.rate[manpowerResource] >= 0 ? "+" : ""}${fmt(Math.round(r.rate[manpowerResource]))}/h)` : bal;
    }
    return row;
  });
  html += `<table><thead><tr><th>Day</th>${feasible.map(c => `<th>${escapeHtml(c.countryName)}</th>`).join("")}</tr></thead><tbody>`;
  for (const row of manpowerTableRows) {
    html += `<tr><td>${escapeHtml(row.day)}</td>${feasible.map(c => `<td>${escapeHtml(row[c.countryName])}</td>`).join("")}</tr>`;
  }
  html += `</tbody></table>\n`;

  const outPath = path.resolve(`tmp/${outputDir}/daily-balances/iron-db-coalition.html`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buildHtml("Iron Daily Balance — Coalition", html), "utf8");
  console.log(`→ wrote ${outPath}`);
}
