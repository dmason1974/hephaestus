import fs from "node:fs";
import path from "node:path";

import type { Resource } from "../../core/constants.js";
import { POOLED_RESOURCES } from "../../core/constants.js";
import { scenarioStartAbsoluteHour, toAbsoluteHour } from "../../core/time.js";
import type { CityEcoResult, CountryEcoBeamResult } from "../../engine/eco/city-eco-beam.js";
import { resimulateHourlyProductionWithExtraActions, WEIGHT_THRESHOLD } from "../../engine/eco/city-eco-beam.js";
import type { BuildingId } from "../../engine/orchestration/build-order-timeline.js";
import { classifyDemands, getBatchSize, type CountryForceProjectionResult } from "../../engine/optimization/country-force-projection.js";
import {
  computeCoalitionPlanWeights,
  computeParityGateWeights,
  WEIGHT_FORMULA_EXCLUDED_RESOURCES,
  type PlanWeights,
} from "../../engine/optimization/joint-city-optimizer.js";
import { computeEcoCreditedForceProjection } from "../../engine/optimization/eco-credited-force-projection.js";
import { computeGarrisonUpkeep } from "../../engine/optimization/garrison-upkeep.js";
import type { ResourceCost } from "../../engine/optimization/types.js";
import {
  computeCountryResourceBalance,
  computeCoalitionResourceBalance,
  type CountryResourceBalance,
} from "../../engine/reporting/coalition-resource-balance.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioCoalitionPlan } from "../../scenarios/io/load-coalition-plan.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadMergedUnitCatalogForScenario } from "../../scenarios/io/load-unit-catalog.js";

// ── Config ────────────────────────────────────────────────────────────────────

const scenarioId = process.env.RP_SCENARIO ?? "elite/antarctica";
const planId = process.env.RP_PLAN;
if (!planId) {
  throw new Error("RP_PLAN is required (e.g. RP_PLAN=pnth-v-iron-2026-aug) — this harness produces the coalition's real balance sheet, so it refuses to silently fall back to a stale default plan.");
}
const countryFilter = process.env.RP_COUNTRY ?? "all";
const maxRoLevel = parsePositiveInt(process.env.RP_MAX_RO, 5);
const beamWidth = parsePositiveInt(process.env.RP_BEAM_WIDTH, 50);
const topN = parsePositiveInt(process.env.RP_TOP_N, 3);
const garrisonDisbandDay = parsePositiveInt(process.env.RP_GARRISON_DISBAND_DAY, 4);
const outputFilePath = path.resolve(process.env.RP_OUTPUT_FILE?.trim() ?? "tmp/resource-projection.html");

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── Data loading ──────────────────────────────────────────────────────────────

const plan = loadScenarioCoalitionPlan(scenarioId, planId);
const scenario = loadScenarioFile(scenarioId);
const buildings = loadBuildingsFile(path.resolve("data/buildings.yml"));
const catalog = loadMergedUnitCatalogForScenario(scenarioId);
const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
const deadlineAbsHour = scenarioAbsHour + plan.truce_days * 24;
const hoursToSimulate = plan.truce_days * 24;

const RESOURCE_KEYS: Resource[] = ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"];

// ── HTML helpers ────────────────────────────────────────────────────────────

function escapeHtml(value: unknown): string {
  return String(value ?? "")
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

/** Renders a labelled balance sheet table where the net row has red/green coloured cells. */
function htmlBalanceSheet(rows: Array<{ label: string; values: Record<Resource, number> }>, netRowLabel: string, resources: Resource[]): string {
  const head = `<tr><th></th>${resources.map(r => `<th>${escapeHtml(r)}</th>`).join("")}</tr>`;
  const body = rows.map(row => {
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
  }).join("");
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
  .surplus { color: #1a7f37; font-weight: 600; }
  .deficit { color: #cf222e; font-weight: 600; }
  .skipped { color: #888; font-style: italic; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

// ── Per-country analysis ───────────────────────────────────────────────────

type CountryAnalysis = {
  balance: CountryResourceBalance;
  cityNameMap: Map<string, string>;
  actualEco: CountryEcoBeamResult;
  forceProjection: CountryForceProjectionResult;
};

type CountryContext = {
  countryId: string;
  country: ReturnType<typeof loadScenarioCountry>;
  doctrine: string;
  status: "homeland" | "occupied";
  captureAbsHour: number | undefined;
  demands: import("../../schemas/coalition-force-plan-schema.js").Demand[];
  researchAsapPins: import("../../schemas/coalition-force-plan-schema.js").CountryPlan["research_asap_pins"];
};

function loadCountryContext(countryId: string): CountryContext {
  const country = loadScenarioCountry(scenarioId, countryId);
  const doctrine = country.country.doctrine;
  const countryPlan = plan.countries[countryId];
  const status = countryPlan?.status ?? "homeland";
  const captureDay = countryPlan?.capture_day ?? 4;
  const captureAbsHour = status === "occupied" ? toAbsoluteHour(captureDay, 0) : undefined;
  return {
    countryId, country, doctrine, status, captureAbsHour,
    demands: countryPlan?.demands ?? [],
    researchAsapPins: countryPlan?.research_asap_pins,
  };
}

// Every country's demands are loaded regardless of RP_COUNTRY — computing the
// coalition-wide eco weight (below) needs every homeland country's demand list,
// even when only one country's HTML is being written this run. This is cheap
// (no beam search) so it doesn't reintroduce the cost of a full coalition run.
const allPlanCountryIds = Object.keys(plan.countries);
const countryContexts = new Map<string, CountryContext>(
  allPlanCountryIds.map(id => [id, loadCountryContext(id)]),
);

// Coalition-wide eco weights (Bug 2 fix): every homeland country's eco beam is
// weighted by the AGGREGATE coalition demand, not its own narrow demand list —
// see computeCoalitionPlanWeights's docstring for why (a country whose own force
// plan barely touches a resource still needs to invest in it if the shared pool
// needs it badly, e.g. Italy's electronics-tile city for India/Japan's SASF/UAV
// demand). The eco beam's own scoring is otherwise fully unconditional/undamped —
// this only changes which weights it's handed.
console.log("[coalition] computing coalition-wide eco weights (aggregate demand across every homeland country)...");
function buildCoalitionEcoWeights(): PlanWeights {
  return computeCoalitionPlanWeights(
    Array.from(countryContexts.values())
      .filter(ctx => ctx.status === "homeland")
      .map(ctx => {
        const { activeDemands } = classifyDemands(ctx.demands, ctx.doctrine, catalog);
        return {
          doctrine: ctx.doctrine,
          demands: activeDemands.map(d => ({ unitId: d.unitId, effectiveCount: Math.ceil(d.count / getBatchSize(d.unitId, catalog)) })),
        };
      }),
    catalog, plan.truce_days,
  );
}
const baseCoalitionEcoWeights = buildCoalitionEcoWeights();
console.log(`  ${(Object.entries(baseCoalitionEcoWeights) as [Resource, number][]).map(([r, w]) => `${r}=${w.toFixed(2)}`).join(", ")}`);

/**
 * @param gateWeights Coalition-derived resource weights (see computeParityGateWeights)
 *   used ONLY to gate which cities' candidate pools include
 *   arms_industry/air_base/naval_base (Axis B) — defaults to the base coalition-wide
 *   weights (round 0 of the main loop's parity iteration).
 */
function analyseCountry(countryId: string, gateWeights: PlanWeights = baseCoalitionEcoWeights): CountryAnalysis {
  const ctx = countryContexts.get(countryId) ?? loadCountryContext(countryId);
  const { country, doctrine, status, captureAbsHour } = ctx;

  console.log(`[${countryId}] running actual eco build (Unit 1.5) + force projection (status=${status})...`);

  const { forceProjection, actualEco } = computeEcoCreditedForceProjection(
    ctx,
    {
      scenario, buildings, catalog, scenarioAbsHour, deadlineAbsHour,
      truceDays: plan.truce_days, maxRoLevel, hoursToSimulate, beamWidth, topN,
      researchBufferHours: plan.research_buffer_hours,
    },
    gateWeights,
  );

  // Phase 2 (Bug 1): re-simulate hourly production for any city with backfilled
  // steps (guaranteed builds pulled forward into idle eco-phase time), so the
  // balance sheet credits their real production bonus (e.g. recruiting_office's
  // manpower bonus) at their real, earlier completion hour — instead of ecoIncome
  // only ever reflecting the beam's own organically-chosen actions. Does not
  // change ecoBuildCost (below) or forceProjection.costs — those already cost the
  // full required levels regardless of build timing (formula-based, see
  // country-force-projection.ts), so crediting backfilled cost there too would
  // double-count it.
  const captureRelHour = captureAbsHour !== undefined ? Math.max(0, captureAbsHour - scenarioAbsHour) : 0;
  const resimulatedCityResults: CityEcoResult[] = actualEco.cityResults.map(cityResult => {
    const bareCityId = cityResult.cityId.slice(cityResult.cityId.indexOf(":") + 1);
    const slot = forceProjection.citySlots.find(s => s.cityId === bareCityId);
    if (!slot || slot.ecoBackfillSteps.length === 0) return cityResult;

    const extraActions = slot.ecoBackfillSteps.map(step => ({
      cityId: cityResult.cityId,
      buildingId: step.buildingId as BuildingId,
      targetLevel: step.toLevel,
      startHour: step.startHour - scenarioAbsHour,
    }));
    const hourlyCityProduction = resimulateHourlyProductionWithExtraActions(
      country, bareCityId, status, scenario, buildings,
      cityResult.bestActions, extraActions, hoursToSimulate, captureRelHour,
    );
    return { ...cityResult, hourlyCityProduction };
  });

  const ecoBuildCost: ResourceCost = {};
  for (const city of actualEco.cityResults) {
    for (const [r, amount] of Object.entries(city.totalEcoBuildCost)) {
      if (amount) ecoBuildCost[r as Resource] = (ecoBuildCost[r as Resource] ?? 0) + amount;
    }
  }

  const garrisonUpkeep = status === "homeland"
    ? computeGarrisonUpkeep(scenario, catalog, doctrine, scenarioAbsHour, toAbsoluteHour(garrisonDisbandDay, 0))
    : { hours: 0, totalUpkeep: {}, units: [] };

  const startingBalance = status === "homeland" ? (country.starting_balance ?? {}) : {};

  const balance = computeCountryResourceBalance({
    countryId,
    countryName: country.country.name,
    doctrine,
    catalog,
    scenarioAbsHour,
    hoursToSimulate,
    cityResults: resimulatedCityResults,
    forceProjection,
    ecoBuildCost,
    garrisonUpkeep,
    startingBalance,
  });

  const cityNameMap = new Map<string, string>(country.cities.map(c => [c.id, c.name]));

  return { balance, cityNameMap, actualEco, forceProjection };
}

function zeroResources(): Record<Resource, number> {
  return { supplies: 0, components: 0, fuel: 0, rares: 0, electronics: 0, cash: 0, manpower: 0 };
}

// ── Build plan (bp-<country>.html): balance + research + combined infra/mob + force projection ──
// This is the only per-country HTML output — it supersedes the old rp-<country>.html
// (balance-only) whose entire content duplicated this file's section 1.

function resourceCostHeader(): string {
  return `<tr><th></th>${RESOURCE_KEYS.map(r => `<th>${escapeHtml(r)}</th>`).join("")}</tr>`;
}

function resourceCostRow(label: string, cost: ResourceCost): string {
  return `<tr><td>${escapeHtml(label)}</td>${RESOURCE_KEYS.map(r => {
    const v = Math.round(cost[r] ?? 0);
    return `<td>${v !== 0 ? fmt(v) : "—"}</td>`;
  }).join("")}</tr>`;
}

function renderResearchSection(forceProjection: CountryForceProjectionResult): string {
  const rows = forceProjection.researchSegments
    .slice()
    .sort((a, b) => a.slot - b.slot || a.startAbsoluteHour - b.startAbsoluteHour)
    .map(s => ({
      slot: `Slot ${s.slot}`,
      unit: s.unitId.replaceAll("_", " "),
      level: s.level,
      start: fmtAbsHour(s.startAbsoluteHour),
      duration: `${s.durationHours}h`,
    }));
  return htmlTable(rows, ["slot", "unit", "level", "start", "duration"]);
}

/**
 * Merges each city's actual eco build (Unit 1.5) with its force-projection infra
 * chain and mob queue (Unit 2) into one chronological timeline. Eco steps are only
 * included up to what the flip point actually credits (buildingLevelsAtAbsHour) —
 * matching the eco-credit logic buildCityInfraStepsFromEco itself uses — since any
 * later theoretical eco step wouldn't really happen once the city has flipped.
 * Cities with no force-projection slot (pure eco, not producing any demand) show
 * their full eco sequence uncredited/untruncated.
 */
function renderCombinedInfraSection(analysis: CountryAnalysis): string {
  const { cityNameMap, actualEco, forceProjection } = analysis;
  const slotByCityId = new Map(forceProjection.citySlots.map(s => [s.cityId, s]));

  // HQ is the capital by default, but relocate_headquarters (capped to at most one
  // city — see actual-eco-build.ts) can move it; whichever city actually built it
  // is the real current HQ.
  const relocatedHq = actualEco.cityResults.find(r => r.bestActions.some(a => a.buildingId === "relocate_headquarters"));
  const hqCityId = relocatedHq?.cityId ?? actualEco.cityResults.find(r => r.capital)?.cityId;

  const sortedCityResults = actualEco.cityResults.slice().sort((a, b) => {
    const nameA = cityNameMap.get(a.cityId.slice(a.cityId.indexOf(":") + 1)) ?? a.cityId;
    const nameB = cityNameMap.get(b.cityId.slice(b.cityId.indexOf(":") + 1)) ?? b.cityId;
    return nameA.localeCompare(nameB);
  });

  let html = "";
  for (const cityEco of sortedCityResults) {
    const bareCityId = cityEco.cityId.slice(cityEco.cityId.indexOf(":") + 1);
    const cName = cityNameMap.get(bareCityId) ?? bareCityId;
    const slot = slotByCityId.get(bareCityId);
    const hqMarker = cityEco.cityId === hqCityId ? "★ " : "";

    const rows: Array<{ absHour: number; step: string }> = [];

    if (slot) {
      const creditedLevels = cityEco.buildingLevelsAtAbsHour(slot.flipPointAbsHour) as Record<string, number | undefined>;
      for (const a of cityEco.bestActions) {
        if ((creditedLevels[a.buildingId] ?? 0) >= a.targetLevel) {
          rows.push({ absHour: (a.startHour ?? 0) + scenarioAbsHour, step: `[eco] ${a.buildingId.replaceAll("_", " ")} L${a.targetLevel}` });
        }
      }
      // Guaranteed post-flip builds (e.g. recruiting_office L2) pulled forward into
      // otherwise-idle eco-phase queue time — never in bestActions (the beam never
      // organically chose them), so rendered from their own source, not credited levels.
      for (const b of slot.ecoBackfillSteps) {
        rows.push({ absHour: b.startHour, step: `[eco-backfill] ${b.name}` });
      }
      rows.push({ absHour: slot.flipPointAbsHour, step: `→ FLIP — eco to military` });
      for (const s of slot.infraSteps) {
        rows.push({ absHour: s.startHour, step: `[infra] ${s.name}` });
      }
      for (const m of slot.mobSteps) {
        rows.push({ absHour: m.startAbsHour, step: `[mob] ${m.unitId.replaceAll("_", " ")}${m.level ? ` L${m.level}` : ""} ×${m.count}` });
      }
    } else {
      for (const a of cityEco.bestActions) {
        rows.push({ absHour: (a.startHour ?? 0) + scenarioAbsHour, step: `[eco] ${a.buildingId.replaceAll("_", " ")} L${a.targetLevel}` });
      }
    }

    rows.sort((a, b) => a.absHour - b.absHour);
    const tableRows = rows.map((r, i) => ({ "#": i + 1, at: fmtAbsHour(r.absHour), step: r.step }));

    html += `<h3>${hqMarker}${escapeHtml(cName)} (${escapeHtml(cityEco.resource)})${slot ? ` — ${escapeHtml(slot.primaryUnitId.replaceAll("_", " "))}, RO L${slot.roLevel}` : ""}</h3>\n`;
    html += htmlTable(tableRows, ["#", "at", "step"]);
  }
  return html;
}

function renderBuildPlanHtml(analysis: CountryAnalysis): string {
  const { balance, forceProjection } = analysis;

  let html = `<h1>${escapeHtml(balance.countryName)}</h1>\n`;

  if (forceProjection.missingDataDemands.length > 0) {
    html += `<p class="deficit">⚠ MISSING DOCTRINE DATA — excluded from this plan entirely (not planned, not costed):</p>\n`;
    html += `<ul>${forceProjection.missingDataDemands.map(d =>
      `<li class="deficit">${escapeHtml(d.unitId)} × ${d.count} — no mobilisation data for this country's doctrine in the unit catalog</li>`
    ).join("")}</ul>\n`;
  }

  // 1. Resource balance
  html += `<h2>Resource Balance</h2>\n`;
  html += `<p class="label">Manpower is not pooled — checked per-country only.</p>\n`;
  html += htmlBalanceSheet([
    { label: "Eco income (flip-truncated)", values: balance.ecoIncome },
    { label: "+ Starting balance", values: balance.startingBalance },
    { label: "− Eco build cost", values: balance.ecoBuildCost },
    { label: "− Force costs (infra + mob + upkeep)", values: balance.forceCosts },
    { label: "− Garrison upkeep", values: balance.garrisonUpkeep },
    { label: "= Net balance", values: balance.netBalance },
  ], "= Net balance", RESOURCE_KEYS);

  // 2. Research
  html += `<h2>Research</h2>\n`;
  html += `<p class="label">L1 JIT (ends at deadline − mob window); L2+ JIT from deadline.</p>\n`;
  html += renderResearchSection(forceProjection);

  // 3. Combined infrastructure build (eco + mob)
  html += `<h2>Infrastructure Build (eco + military, combined per city)</h2>\n`;
  html += `<p class="label">Eco steps shown only up to each city's flip point (credited toward the military chain, matching what buildCityInfraStepsFromEco actually skips); "[eco-backfill]" steps are guaranteed post-flip builds pulled forward into otherwise-idle eco-phase queue time; "→ FLIP" marks the switch to military infra; mob queue follows.</p>\n`;
  html += renderCombinedInfraSection(analysis);

  // 4. Force projection
  html += `<h2>Force Projection</h2>\n`;
  html += `<p class="label">${escapeHtml(forceProjection.demandLabels.join(" · "))}</p>\n`;
  if (forceProjection.infeasible) {
    html += `<p class="deficit">INFEASIBLE${forceProjection.reason ? ` (${escapeHtml(forceProjection.reason)})` : ""}</p>\n`;
  } else {
    html += `<table>${resourceCostHeader()}
      ${resourceCostRow("Infra (RO)", forceProjection.costs.infraRo)}
      ${resourceCostRow("Infra (buildings)", forceProjection.costs.infraBuildings)}
      ${resourceCostRow("Mobilisation", forceProjection.costs.mobilisation)}
      ${resourceCostRow("Upkeep (stepped)", forceProjection.costs.upkeep)}
      ${resourceCostRow("Province mob + mercenary_outpost", forceProjection.costs.provinceMobilisation)}
      ${resourceCostRow("Province upkeep (flat)", forceProjection.costs.provinceUpkeep)}
      ${resourceCostRow("Total", forceProjection.costs.total)}
    </table>\n`;
  }
  if (forceProjection.provinceMobResults.length > 0) {
    html += `<h3>Province Mobilisation Detail</h3>\n`;
    html += `<ul>${forceProjection.provinceMobResults.map(r =>
      `<li>${escapeHtml(r.unitId)} × ${r.count} — mercenary_outpost → L${r.mercenaryOutpostRequiredLevel} ` +
      `(${r.mercenaryOutpostBuildHours}h cumulative), capacity ${r.provinceCount} provinces` +
      `<ul>${r.tranches.map(t =>
        `<li>L${t.level}: ${t.count} units — research floor hour ${t.mobilisationEarliestHour}, ` +
        `mobilise ${t.mobStartHour}→${t.completionHour} (${t.mobilizationDurationHours}h)</li>`
      ).join("")}</ul></li>`
    ).join("")}</ul>\n`;
  }
  if (forceProjection.skippedDemands.length > 0) {
    html += `<h3>Skipped Demands</h3>\n`;
    html += `<ul>${forceProjection.skippedDemands.map(d => `<li class="skipped">${escapeHtml(d.unitId)} × ${d.count} — launcher platform (zero mob cost)</li>`).join("")}</ul>\n`;
  }

  return html;
}

// ── Main ───────────────────────────────────────────────────────────────────

fs.mkdirSync(path.resolve("tmp"), { recursive: true });

const countryIds = countryFilter === "all" ? Object.keys(plan.countries) : [countryFilter];

function writeCountryHtml(countryId: string, analysis: CountryAnalysis): void {
  const bpHtml = buildHtml(`Build Plan — ${analysis.balance.countryName}`, renderBuildPlanHtml(analysis));
  const bpOutPath = path.resolve(`tmp/bp-${countryId}.html`);
  fs.writeFileSync(bpOutPath, bpHtml, "utf8");
  console.log(`  → wrote ${bpOutPath}`);
}

// Axis B: gate weights start at the base coalition-wide demand aggregate, then
// iterate toward real cost/income utilization parity (computeParityGateWeights) —
// every homeland country is re-analysed each round (Axis A's own horizon loop runs
// fresh inside each analyseCountry call, since a city's real flip point can itself
// shift when its candidate pool gates open/close). Convergence is checked on the
// SET of resources crossing WEIGHT_THRESHOLD, not a numeric weight tolerance — two
// weight vectors gating the same resource set produce identical beam output.
const MAX_PARITY_ROUNDS = 3;
let gateWeights = baseCoalitionEcoWeights;
let finalAnalyses = new Map<string, CountryAnalysis>();
let gatedSetPrev: string[] | undefined;
const weightsByRound: PlanWeights[] = [];

for (let round = 0; round < MAX_PARITY_ROUNDS; round++) {
  weightsByRound.push(gateWeights);
  console.log(`[coalition] parity round ${round}: eco build + force projection (gate weights: ${(Object.entries(gateWeights) as [Resource, number][]).map(([r, w]) => `${r}=${w.toFixed(2)}`).join(", ") || "none"})...`);
  const roundAnalyses = new Map<string, CountryAnalysis>();
  for (const id of allPlanCountryIds) {
    roundAnalyses.set(id, analyseCountry(id, gateWeights));
  }
  finalAnalyses = roundAnalyses;

  const coalitionBalance = computeCoalitionResourceBalance(Array.from(roundAnalyses.values()).map(a => a.balance));
  const nextGateWeights = computeParityGateWeights(coalitionBalance.pooledCosts, coalitionBalance.pooledEcoIncome);
  const gatedSetNext = POOLED_RESOURCES.filter(r => (nextGateWeights[r] ?? 0) >= WEIGHT_THRESHOLD).sort();
  const converged = !!gatedSetPrev && gatedSetPrev.length === gatedSetNext.length && gatedSetPrev.every((r, i) => r === gatedSetNext[i]);
  console.log(`  gated (weight >= ${WEIGHT_THRESHOLD}): ${gatedSetNext.join(", ") || "(none)"}${converged ? " — converged" : ""}`);
  if (converged) break;
  gatedSetPrev = gatedSetNext;
  gateWeights = nextGateWeights;
}

for (const id of countryIds) writeCountryHtml(id, finalAnalyses.get(id)!);

const countryBalances: CountryResourceBalance[] = countryIds.map(id => finalAnalyses.get(id)!.balance);

const coalition = computeCoalitionResourceBalance(countryBalances);

let aggBody = `<h1>Coalition Resource Projection</h1>\n`;
aggBody += `<p class="label">Scenario: ${escapeHtml(scenarioId)} · Plan: ${escapeHtml(planId)} · Deadline: ${fmtAbsHour(deadlineAbsHour)} (${plan.truce_days} days) · Garrison disband day ${garrisonDisbandDay}</p>\n`;

aggBody += `<h2>Coalition Eco Weights</h2>\n`;
aggBody += `<p class="label">Round 0 starts at the base coalition-wide demand aggregate (Σ mob + avg-upkeep cost across every homeland country's own demands, cash/manpower excluded). Each later round replaces it with real cost/income utilization parity (computeParityGateWeights) computed from that round's own coalition balance. These weights do two things: gate which cities' candidate pools include arms_industry/air_base/naval_base (WEIGHT_THRESHOLD=${WEIGHT_THRESHOLD}), AND drive the eco beam's own weighted ranking (a weighted sum across all resources, not just each city's native one) — cross-resource cost has to stay visible in the score itself, or a city will happily overspend a scarce resource it doesn't produce as long as its own resource improves. Converged after ${weightsByRound.length} round(s).</p>\n`;
const parityRoundLabels = weightsByRound.map((_, i) => `round ${i}`);
aggBody += htmlTable(
  POOLED_RESOURCES.filter(r => !WEIGHT_FORMULA_EXCLUDED_RESOURCES.includes(r))
    .map(r => {
      const row: Record<string, unknown> = { resource: r };
      weightsByRound.forEach((w, i) => { row[parityRoundLabels[i]] = (w[r] ?? 0).toFixed(3); });
      return row;
    })
    .sort((a, b) => Number(b[parityRoundLabels.at(-1)!]) - Number(a[parityRoundLabels.at(-1)!])),
  ["resource", ...parityRoundLabels],
);

aggBody += `<h2>Coalition Balance Sheet (pooled resources)</h2>\n`;
const grossAvailable: Record<Resource, number> = zeroResources();
for (const r of POOLED_RESOURCES) grossAvailable[r] = coalition.pooledEcoIncome[r] + coalition.pooledStartingBalance[r];
aggBody += htmlBalanceSheet([
  { label: "Eco income (flip-truncated)", values: coalition.pooledEcoIncome },
  { label: "+ Starting balance", values: coalition.pooledStartingBalance },
  { label: "= Gross available", values: grossAvailable },
  { label: "− Costs (eco build + force + garrison)", values: coalition.pooledCosts },
  { label: "= Net balance", values: coalition.netPooledBalance },
], "= Net balance", POOLED_RESOURCES);

aggBody += `<h2>Resource Minima (hourly cash-flow walk)</h2>\n`;
aggBody += `<p class="label">Lowest running pooled balance at any hour in the window. Negative = the coalition pool would go insolvent mid-window even if the end-of-window net is positive. Upkeep uses a continuous L1-rate approximation in this walk (vs. the exact stepped rate in the totals above), so treat this as a shortfall detector, not a bit-exact reconciliation of the totals.</p>\n`;
aggBody += htmlTable(
  coalition.resourceMinima.map(m => ({
    resource: m.resource,
    hour: fmtAbsHour(scenarioAbsHour + m.hour),
    value: fmt(m.value),
  })),
  ["resource", "hour", "value"],
);

aggBody += `<h2>Per-Country Manpower Check (not pooled)</h2>\n`;
aggBody += htmlTable(
  coalition.perCountryManpower.map(c => ({
    country: c.countryName,
    manpowerNetBalance: fmt(c.manpowerNetBalance),
  })),
  ["country", "manpowerNetBalance"],
);

fs.writeFileSync(outputFilePath, buildHtml("Coalition Resource Projection", aggBody), "utf8");
console.log(`→ wrote ${outputFilePath}`);
