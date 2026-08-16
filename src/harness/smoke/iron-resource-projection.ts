// Aggregate summary across the "iron" build plans — reads the already-generated
// tmp/iron-bp-<country>.html files (written by iron-bp-plan.ts) and sums their
// numbers into one coalition-style balance sheet, matching the shape of the
// production aggregate (tmp/resource-projection.html). Deliberately parses the
// existing HTML rather than recomputing anything — the per-country files already
// contain every number needed (per user direction: "it is just a case of reading
// the iron-bp<country>.html and taking the info from there").
//
// Coalition Resource Minima is the one exception to "parse only, don't recompute
// per-hour data": summing each country's own minima *value* is not a true pooled
// minimum — countries hit their own worst hour at very different points in the
// window (confirmed empirically: some homeland countries bottom out on day 2,
// others on day 29), so a naive sum is not a number that ever really occurs. Both
// iron-bp-plan.ts and iron-occupied-plan.ts now embed their raw hourly net-flow
// array as a JSON <script> tag (id="iron-hourly-net-flow") specifically so this
// script can sum real per-hour deltas across countries before taking the minimum —
// still no engine recomputation, just reading a second, richer data format out of
// the same already-generated files.
//
// Run via IRON_COUNTRIES=italy,south_africa,... npm run smoke:iron-resource-projection
// (defaults to the 4 countries generated last session).
import fs from "node:fs";
import path from "node:path";

import type { Resource } from "../../core/constants.js";
import { POOLED_RESOURCES } from "../../core/constants.js";

const RESOURCE_KEYS: Resource[] = ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"];

const countryIds = (process.env.IRON_COUNTRIES ?? "italy,south_africa,pakistan,new_zealand")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const outputDir = process.env.IRON_OUTPUT_DIR ?? "pnth-v-iron-aug26";
const outputFilePath = path.resolve(process.env.IRON_OUTPUT_FILE?.trim() ?? `tmp/${outputDir}/iron-resource-projection.html`);

// ── Parsing ─────────────────────────────────────────────────────────────────

type ResourceBalanceRow = Record<Resource, number>;

type CountryMinima = { minimaHour: string; minimaValue: number; firstNegHour: string; firstNegValue: string };

type ParsedCountry = {
  countryId: string;
  countryName: string;
  doctrine: string;
  status: string;
  deadline: string;
  demandLabels: string;
  feasible: boolean;
  balance?: Record<string, ResourceBalanceRow>; // row label -> resource -> value
  minima?: Record<Resource, CountryMinima>;
  hourlyNetFlow?: { scenarioAbsHour: number; resourceOrder: Resource[]; hours: number[][] };
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

function parseResourceBalanceTable(html: string): Record<string, ResourceBalanceRow> | undefined {
  const sectionMatch = html.match(/<h2>Resource Balance<\/h2>[\s\S]*?<table>([\s\S]*?)<\/table>/);
  if (!sectionMatch) return undefined;
  const rows: Record<string, ResourceBalanceRow> = {};
  const rowRe = /<tr><td><strong>([^<]+)<\/strong><\/td>((?:<td[^>]*>[^<]*<\/td>){7})<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(sectionMatch[1]))) {
    const label = m[1].trim();
    const cellRe = /<td[^>]*>([^<]*)<\/td>/g;
    const values: number[] = [];
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(m[2]))) values.push(parseNum(cm[1]));
    rows[label] = zipResources(values);
  }
  return Object.keys(rows).length > 0 ? rows : undefined;
}

function parseResourceMinimaTable(html: string): Record<Resource, CountryMinima> | undefined {
  const sectionMatch = html.match(/<h2>Resource Minima[^<]*<\/h2>[\s\S]*?<table>([\s\S]*?)<\/table>/);
  if (!sectionMatch) return undefined;
  const rows = {} as Record<Resource, CountryMinima>;
  const rowRe = /<tr><td>([^<]+)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(sectionMatch[1]))) {
    const resource = m[1].trim() as Resource;
    if (!RESOURCE_KEYS.includes(resource)) continue;
    rows[resource] = {
      firstNegHour: m[2].trim(),
      firstNegValue: m[3].trim(),
      minimaHour: m[4].trim(),
      minimaValue: parseNum(m[5]),
    };
  }
  return Object.keys(rows).length > 0 ? rows : undefined;
}

function parseHourlyNetFlow(html: string): { scenarioAbsHour: number; resourceOrder: Resource[]; hours: number[][] } | undefined {
  const m = html.match(
    /<script type="application\/json" id="iron-hourly-net-flow" data-scenario-abs-hour="([^"]+)" data-resource-order="([^"]+)">([\s\S]*?)<\/script>/
  );
  if (!m) return undefined;
  const scenarioAbsHour = parseNum(m[1]);
  const resourceOrder = m[2].split(",") as Resource[];
  const hours = JSON.parse(m[3]) as number[][];
  return { scenarioAbsHour, resourceOrder, hours };
}

function parseCountryFile(countryId: string): ParsedCountry {
  const filePath = path.resolve(`tmp/${outputDir}/build-plans/iron-bp-${countryId}.html`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`${filePath} not found — run IRON_COUNTRY=${countryId} npm run smoke:iron-bp-plan first`);
  }
  const html = fs.readFileSync(filePath, "utf8");

  const nameMatch = html.match(/<h1>([^<]+) — Iron Build Plan<\/h1>/);
  const countryName = nameMatch?.[1]?.trim() ?? countryId;

  const headerMatch = html.match(/Doctrine:\s*([^·]+)·\s*Status:\s*([^·]+)·\s*Deadline:\s*([^·]+)·/);
  const doctrine = headerMatch?.[1]?.trim() ?? "?";
  const status = headerMatch?.[2]?.trim() ?? "?";
  const deadline = headerMatch?.[3]?.trim() ?? "?";

  const demandMatch = html.match(/<h2>Force Projection<\/h2>\s*<p class="label">([^<]*)<\/p>/);
  const demandLabels = demandMatch?.[1]?.trim() ?? "";

  const feasible = !html.includes('<p class="infeasible">No feasible city allocation.</p>');

  return {
    countryId,
    countryName,
    doctrine,
    status,
    deadline,
    demandLabels,
    feasible,
    balance: feasible ? parseResourceBalanceTable(html) : undefined,
    minima: feasible ? parseResourceMinimaTable(html) : undefined,
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

function htmlTable(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0) return "<p><em>None</em></p>\n";
  const headers = columns ?? Object.keys(rows[0]);
  const head = `<tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
  const body = rows.map(row => `<tr>${headers.map(h => `<td>${escapeHtml(row[h])}</td>`).join("")}</tr>`).join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>\n`;
}

function htmlBalanceSheet(rows: Array<{ label: string; values: ResourceBalanceRow }>, netRowLabel: string, resources: Resource[]): string {
  const head = `<tr><th></th>${resources.map(r => `<th>${escapeHtml(r)}</th>`).join("")}</tr>`;
  const body = rows
    .map(row => {
      const isNet = row.label === netRowLabel;
      const labelCell = `<td><strong>${escapeHtml(row.label)}</strong></td>`;
      const dataCells = resources.map(r => {
        const v = row.values[r] ?? 0;
        const text = fmt(v);
        if (isNet) {
          const style = v < 0 ? ` style="color:#cf222e;font-weight:600"` : v > 0 ? ` style="color:#1a7f37;font-weight:600"` : "";
          return `<td${style}>${escapeHtml(text)}</td>`;
        }
        return `<td>${escapeHtml(text)}</td>`;
      });
      return `<tr>${labelCell}${dataCells.join("")}</tr>`;
    })
    .join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>\n`;
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
  .infeasible { color: #cf222e; font-weight: bold; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

// ── Parse + aggregate ───────────────────────────────────────────────────────

const countries = countryIds.map(parseCountryFile);
const feasibleCountries = countries.filter(c => c.feasible && c.balance);

function zeroPooled(): ResourceBalanceRow {
  const row = {} as ResourceBalanceRow;
  RESOURCE_KEYS.forEach(r => (row[r] = 0));
  return row;
}

const pooledStartingBalance = zeroPooled();
const pooledEcoIncome = zeroPooled();
const pooledInfraCosts = zeroPooled();
const pooledMobilisationCosts = zeroPooled();
const pooledUpkeepCosts = zeroPooled();

for (const c of feasibleCountries) {
  const b = c.balance!;
  for (const r of POOLED_RESOURCES) {
    pooledStartingBalance[r] += b["Starting Balance"]?.[r] ?? 0;
    pooledEcoIncome[r] += b["Eco Income"]?.[r] ?? 0;
    pooledInfraCosts[r] += b["Infra Costs"]?.[r] ?? 0;
    pooledMobilisationCosts[r] += b["Mobilisation Costs"]?.[r] ?? 0;
    pooledUpkeepCosts[r] += b["Upkeep Costs"]?.[r] ?? 0;
  }
}

const grossAvailable = zeroPooled();
const netBalance = zeroPooled();
for (const r of POOLED_RESOURCES) {
  grossAvailable[r] = pooledStartingBalance[r] + pooledEcoIncome[r];
  netBalance[r] = grossAvailable[r] - pooledInfraCosts[r] - pooledMobilisationCosts[r] - pooledUpkeepCosts[r];
}
const pooledCosts = zeroPooled();
for (const r of POOLED_RESOURCES) pooledCosts[r] = pooledInfraCosts[r] + pooledMobilisationCosts[r] + pooledUpkeepCosts[r];

// ── Render ──────────────────────────────────────────────────────────────────

let body = `<h1>Iron Coalition Resource Projection</h1>\n`;
body += `<p class="label">Aggregate of the "iron" hand-specified build plans (deterministic eco heuristic + unmodified Unit 2 force projection), not the coalition-weight beam. Built by summing the already-generated per-country tmp/iron-bp-&lt;country&gt;.html files, not by recomputing anything.</p>\n`;

body += `<h2>Countries in Scope</h2>\n`;
body += htmlTable(
  countries.map(c => ({
    country: c.countryName,
    doctrine: c.doctrine,
    status: c.status,
    deadline: c.deadline,
    demands: c.demandLabels || "—",
    feasible: c.feasible ? "yes" : "INFEASIBLE",
  })),
  ["country", "doctrine", "status", "deadline", "demands", "feasible"],
);

if (feasibleCountries.length < countries.length) {
  const infeasible = countries.filter(c => !c.feasible).map(c => c.countryName);
  body += `<p class="infeasible">Excluded from the balance sheet below (infeasible in their own build plan): ${escapeHtml(infeasible.join(", "))}</p>\n`;
}

body += `<h2>Coalition Balance Sheet (pooled resources)</h2>\n`;
body += `<p class="label">Manpower is not pooled — see the Per-Country Resource Minima table below for each country's own manpower figure. Pooled across: ${escapeHtml(feasibleCountries.map(c => c.countryName).join(", "))}.</p>\n`;
body += htmlBalanceSheet(
  [
    { label: "Eco Income", values: pooledEcoIncome },
    { label: "+ Starting Balance", values: pooledStartingBalance },
    { label: "= Gross Available", values: grossAvailable },
    { label: "− Infra Costs", values: pooledInfraCosts },
    { label: "− Mobilisation Costs", values: pooledMobilisationCosts },
    { label: "− Upkeep Costs", values: pooledUpkeepCosts },
    { label: "= Net Balance", values: netBalance },
  ],
  "= Net Balance",
  POOLED_RESOURCES,
);

// True hour-aligned pooled walk: sum every feasible country's real per-hour delta
// (not their individual minima values — see file header for why that's wrong),
// starting from the pooled starting balance, then find the minimum of the summed
// series. This is the number that actually determines whether the coalition plan
// is executable at every hour, not just at the end of the window.
const countriesWithFlow = feasibleCountries.filter(c => c.hourlyNetFlow);
const hoursToSimulate = Math.max(0, ...countriesWithFlow.map(c => c.hourlyNetFlow!.hours.length));
const pooledScenarioAbsHour = countriesWithFlow[0]?.hourlyNetFlow?.scenarioAbsHour ?? 0;
const resourceIndexByCountry = countriesWithFlow.map(c => {
  const order = c.hourlyNetFlow!.resourceOrder;
  const idx = {} as Record<Resource, number>;
  for (const r of POOLED_RESOURCES) idx[r] = order.indexOf(r);
  return idx;
});

const pooledRunning = { ...pooledStartingBalance };
const pooledMinima = {} as Record<Resource, { value: number; hour: number }>;
const pooledFirstNegative = {} as Record<Resource, { value: number; hour: number } | undefined>;
for (const r of POOLED_RESOURCES) {
  pooledMinima[r] = { value: pooledStartingBalance[r], hour: pooledScenarioAbsHour };
  pooledFirstNegative[r] = pooledStartingBalance[r] < 0 ? { value: pooledStartingBalance[r], hour: pooledScenarioAbsHour } : undefined;
}

for (let h = 0; h < hoursToSimulate; h++) {
  for (const r of POOLED_RESOURCES) {
    let delta = 0;
    for (let i = 0; i < countriesWithFlow.length; i++) {
      const idx = resourceIndexByCountry[i][r];
      if (idx === -1) continue;
      delta += countriesWithFlow[i].hourlyNetFlow!.hours[h]?.[idx] ?? 0;
    }
    pooledRunning[r] += delta;
    const absHour = pooledScenarioAbsHour + h;
    if (pooledRunning[r] < pooledMinima[r].value) pooledMinima[r] = { value: pooledRunning[r], hour: absHour };
    if (pooledFirstNegative[r] === undefined && pooledRunning[r] < 0) pooledFirstNegative[r] = { value: pooledRunning[r], hour: absHour };
  }
}

body += `<h2>Coalition Resource Minima (pooled, hour-aligned)</h2>\n`;
body += `<p class="label">True pooled walk — sums every feasible country's real per-hour net flow before finding the minimum, so countries hitting their own worst hour at different points in the window don't get incorrectly stacked together. This is the number that actually constrains the coalition plan: a negative value here means the shared pool cannot fund the plan as sequenced at that hour, regardless of how healthy any single country looks in isolation (a negative per-country minimum is usually resolvable by redistribution from the pool — this is not). Inherits each country's own continuous-upkeep-rate approximation, so treat as a shortfall detector, not a bit-exact reconciliation of the Coalition Balance Sheet totals above. Manpower excluded (not pooled).</p>\n`;
body += htmlTable(
  POOLED_RESOURCES.map(r => ({
    resource: r,
    "first-neg hour": pooledFirstNegative[r] ? fmtAbsHour(pooledFirstNegative[r]!.hour) : "—",
    "first-neg value": pooledFirstNegative[r] ? fmt(pooledFirstNegative[r]!.value) : "—",
    "minima hour": fmtAbsHour(pooledMinima[r].hour),
    "minima value": fmt(pooledMinima[r].value),
  })),
  ["resource", "first-neg hour", "first-neg value", "minima hour", "minima value"],
);

body += `<h2>Per-Country Resource Minima (not pooled)</h2>\n`;
body += `<p class="label">Each country's own lowest running balance over its own build plan's hourly walk (see that country's iron-bp-&lt;country&gt;.html for the full detail) — shown side by side for informational comparison only. A negative value here is usually not a real constraint on its own (the shared pool can typically cover a single country's local dip) — see the true pooled walk above for what actually constrains the coalition plan.</p>\n`;
body += htmlTable(
  RESOURCE_KEYS.map(r => {
    const row: Record<string, unknown> = { resource: r };
    for (const c of feasibleCountries) row[c.countryName] = c.minima?.[r] ? fmt(c.minima[r].minimaValue) : "—";
    return row;
  }),
  ["resource", ...feasibleCountries.map(c => c.countryName)],
);

fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
fs.writeFileSync(outputFilePath, buildHtml("Iron Coalition Resource Projection", body), "utf8");
console.log(`→ wrote ${outputFilePath}`);
