import fs from "node:fs";
import path from "node:path";

import type { Resource } from "../../core/constants.js";
import { POOLED_RESOURCES, PER_COUNTRY_RESOURCES } from "../../core/constants.js";
import { scenarioStartAbsoluteHour } from "../../core/time.js";
import { durationToHours } from "../../engine/timing/activity-duration.js";
import { runCityEcoBeam, type CityEcoResult } from "../../engine/eco/city-eco-beam.js";
import {
  computeFlipPoint,
  mobilisationWindowHours as computeMobWindow,
  requirementsToLevelMap,
  type FlipPointResult,
} from "../../engine/eco/flip-point-solver.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioCoalitionPlan } from "../../scenarios/io/load-coalition-plan.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadMergedUnitCatalogForScenario } from "../../scenarios/io/load-unit-catalog.js";
import type { CoalitionForcePlan, Demand } from "../../schemas/coalition-force-plan-schema.js";

const RESOURCE_KEYS: Resource[] = ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"];

// ── Config ────────────────────────────────────────────────────────────────────

const planId = process.env.CFP_PLAN ?? "pnth_v_road_2026_jun";
const countryFilter = process.env.CFP_COUNTRY ?? "all";
const beamWidth = parsePositiveInt(process.env.CFP_BEAM_WIDTH, 50);
const topN = parsePositiveInt(process.env.CFP_TOP, 3);
const maxRoLevel = parsePositiveInt(process.env.CFP_MAX_RO, 5);
const maxCityCount = parsePositiveInt(process.env.CFP_MAX_CITIES, 99);
const outputFilePath = path.resolve(process.env.CFP_OUTPUT_FILE?.trim() ?? "tmp/coalition-force-plan.html");

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── Data loading ──────────────────────────────────────────────────────────────

const scenarioId = process.env.CFP_SCENARIO ?? "elite/antarctica";
const plan: CoalitionForcePlan = loadScenarioCoalitionPlan(scenarioId, planId);
const scenario = loadScenarioFile(scenarioId);
const buildings = loadBuildingsFile(path.resolve("data/buildings.yml"));
const catalog = loadMergedUnitCatalogForScenario(scenarioId);
const scenarioAbsHour = scenarioStartAbsoluteHour(scenario);
const deadlineAbsHour = scenarioAbsHour + plan.truce_days * 24;
const hoursToSimulate = plan.truce_days * 24;

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function htmlTable(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "<p><em>None</em></p>";
  const headers = Array.from(
    rows.reduce((set, row) => { for (const key of Object.keys(row)) set.add(key); return set; }, new Set<string>())
  );
  const head = `<tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
  const body = rows.map(row =>
    `<tr>${headers.map(h => `<td>${escapeHtml(row[h]).replaceAll("\n", "<br>")}</td>`).join("")}</tr>`
  ).join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function htmlList(lines: string[]): string {
  if (lines.length === 0) return "<p><em>None</em></p>";
  return `<ul>${lines.map(l => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`;
}

function fmtHour(relHour: number): string {
  const day = Math.floor(relHour / 24) + 1;
  const hour = Math.floor(relHour % 24);
  return `day ${day} h${String(hour).padStart(2, "0")}  (rel ${relHour.toFixed(0)}h)`;
}

function roSpeedBonus(roLevel: number): number {
  return buildings.buildings["recruiting_office"]?.levels[String(roLevel) as "1" | "2" | "3" | "4" | "5"]?.mobilisation_speed_bonus_pct ?? 0;
}

function unitMobTimeHours(unitId: string, doctrine: string): number {
  const unit = catalog.units[unitId];
  if (!unit) return 0;
  const l1mob = (unit.levels?.["1"]?.mobilisation ?? {}) as Record<string, { time: { days?: number; hours?: number; minutes?: number } } | undefined>;
  const docMob = l1mob[doctrine] ?? Object.values(l1mob).find(Boolean);
  if (!docMob) return 0;
  return durationToHours(docMob.time);
}

function unitRequiredLevels(unitId: string, roLevel: number): Record<string, number> {
  const unit = catalog.units[unitId];
  const reqs: string[] = unit?.levels?.["1"]?.requirements ?? [];
  // Exclude unit prerequisites (research chains handled elsewhere)
  const UNIT_PREREQ_PATTERN = /^(air_superiority_fighter|special_forces|tank) level/;
  const levels = requirementsToLevelMap(reqs.filter(r => !UNIT_PREREQ_PATTERN.test(r)));
  levels["recruiting_office"] = roLevel;
  return levels;
}

// ── Income & cost accounting ──────────────────────────────────────────────────

function zeroResourceMap(): Record<Resource, number> {
  return { supplies: 0, components: 0, fuel: 0, rares: 0, electronics: 0, cash: 0, manpower: 0 };
}

function addResources(a: Record<Resource, number>, b: Partial<Record<Resource, number>>): void {
  for (const r of RESOURCE_KEYS) a[r] += b[r] ?? 0;
}

function scaleResources(src: Partial<Record<Resource, number>>, factor: number): Record<Resource, number> {
  const out = zeroResourceMap();
  for (const r of RESOURCE_KEYS) out[r] = (src[r] ?? 0) * factor;
  return out;
}

/**
 * Eco income from a single city up to (but not including) flipRelHour,
 * then flat production for the remainder of the truce window.
 * Does NOT include the coalition starting balance.
 */
function cityIncomeForConfig(city: CityEcoResult, flipRelHour: number): Record<Resource, number> {
  const total = zeroResourceMap();
  const flipH = Math.max(0, Math.min(Math.round(flipRelHour), hoursToSimulate));
  // Eco-build phase: sum per-hour production up to flip point
  for (let h = 0; h < flipH; h++) {
    addResources(total, city.hourlyCityProduction[h] ?? zeroResourceMap());
  }
  // Post-flip phase: production continues flat at the rate at the flip point
  const rateAtFlip = city.hourlyCityProduction[Math.max(0, flipH - 1)] ?? city.hourlyCityProduction[0] ?? zeroResourceMap();
  const remainingHours = hoursToSimulate - flipH;
  if (remainingHours > 0) {
    addResources(total, scaleResources(rateAtFlip, remainingHours));
  }
  return total;
}

/** Full eco income from a city for the entire truce window (no flip). */
function cityFullEcoIncome(city: CityEcoResult): Record<Resource, number> {
  const total = zeroResourceMap();
  for (const prod of city.hourlyCityProduction) addResources(total, prod);
  return total;
}

/**
 * Country income budget for a given configuration:
 * military cities capped at flip point (then flat rate), eco cities full.
 * Starting balance is separate (coalition-wide) and NOT included here.
 */
function countryEcoBudget(
  cityResults: CityEcoResult[],
  assignedCityIds: Set<string>,
  fp: FlipPointResult,
): Record<Resource, number> {
  const total = zeroResourceMap();
  for (const city of cityResults) {
    const cityContrib = assignedCityIds.has(city.cityId)
      ? cityIncomeForConfig(city, Math.max(0, fp.flipPointRelHour))
      : cityFullEcoIncome(city);
    addResources(total, cityContrib);
  }
  return total;
}

/** Cost of the military infra chain for one city × numCities. */
function infraCostForChain(fp: FlipPointResult, numCities: number): Record<Resource, number> {
  const total = zeroResourceMap();
  for (const step of fp.remainingChain) {
    const levelData = buildings.buildings[step.buildingId]?.levels[String(step.toLevel) as "1" | "2" | "3" | "4" | "5"];
    if (levelData?.cost) addResources(total, levelData.cost as Partial<Record<Resource, number>>);
  }
  // Each of the numCities cities pays the full infra chain cost
  return scaleResources(total, numCities);
}

/** L1 mobilisation cost for a demand (× effectiveCount units). */
function mobCostForDemand(unitId: string, doctrine: string, effectiveCount: number): Record<Resource, number> {
  const unit = catalog.units[unitId];
  const l1mob = unit?.levels?.["1"]?.mobilisation as Record<string, { cost?: Partial<Record<Resource, number>> }> | undefined;
  const docMob = l1mob?.[doctrine] ?? Object.values(l1mob ?? {}).find(Boolean);
  if (!docMob?.cost) return zeroResourceMap();
  return scaleResources(docMob.cost as Record<Resource, number>, effectiveCount);
}

/** L1 daily upkeep × effectiveCount × hours from mobilisation start to deadline. */
function upkeepCostForDemand(unitId: string, doctrine: string, effectiveCount: number, mobStartRelHour: number): Record<Resource, number> {
  const unit = catalog.units[unitId];
  const l1upkeep = unit?.levels?.["1"]?.daily_upkeep as Record<string, { cost?: Partial<Record<Resource, number>> }> | undefined;
  const docUpkeep = l1upkeep?.[doctrine] ?? Object.values(l1upkeep ?? {}).find(Boolean);
  if (!docUpkeep?.cost) return zeroResourceMap();
  const hoursActive = Math.max(0, hoursToSimulate - Math.max(0, mobStartRelHour));
  const dailyFraction = hoursActive / 24;
  return scaleResources(docUpkeep.cost as Record<Resource, number>, effectiveCount * dailyFraction);
}

/** Format a net resource balance as a compact shortfall/surplus string. */
function formatNetBalance(net: Record<Resource, number>): string {
  const shortfalls = RESOURCE_KEYS.filter(r => Math.round(net[r]) < 0).map(r => `-${r}:${Math.abs(Math.round(net[r])).toLocaleString()}`);
  if (shortfalls.length === 0) return "✓ affordable";
  return "⚠ " + shortfalls.join(" ");
}

// ── Per-country analysis ──────────────────────────────────────────────────────

type CityEcoSummary = {
  cityId: string;
  cityName: string;
  resource: string;
  capital: boolean;
  bestSequence: string;
  explored: number;
};

type FlipMatrix = {
  unitId: string;
  numCities: number;
  roLevel: number;
  mobWindowHours: number;
  mobWindowDays: number;
  flipRelHour: number;
  flipDay: string;
  ecoHoursCaptured: number;
  ecoBuildingsAtFlip: string;
  remainingBuildHours: number;
  remainingChain: string;
  mobStartDay: string;
  feasible: string;
  // income accounting
  ecoIncome: Record<Resource, number>;
  infraCost: Record<Resource, number>;
  mobCost: Record<Resource, number>;
  upkeepCost: Record<Resource, number>;
  netBalance: Record<Resource, number>;
  affordable: string;
};

type CountryAnalysis = {
  countryId: string;
  countryName: string;
  doctrine: string;
  status: string;
  demands: Demand[];
  ecoSummaries: CityEcoSummary[];
  flipMatrixRows: FlipMatrix[];
  coalitionContribution: CountryCoalitionContribution;
};

function analyseCountry(countryId: string): CountryAnalysis {
  const countryPlan = plan.countries[countryId];
  if (!countryPlan) throw new Error(`Country ${countryId} not in plan`);

  const country = loadScenarioCountry(scenarioId, countryId);
  const doctrine = country.country.doctrine;

  console.log(`\n[${countryId}] Running eco beam search for ${country.cities.length} cities...`);
  const ecoResult = runCityEcoBeam(country, scenario, buildings, {
    hoursToSimulate,
    beamWidth,
    topN,
  }, countryPlan.status as "homeland" | "occupied");

  const ecoSummaries: CityEcoSummary[] = ecoResult.cityResults.map(city => ({
    cityId: city.cityId,
    cityName: city.cityName,
    resource: city.resource,
    capital: city.capital,
    bestSequence: city.top[0]?.sequenceLines.join(" → ") ?? "(no build)",
    explored: city.explored,
  }));

  const cityResults = ecoResult.cityResults;
  const flipMatrixRows: FlipMatrix[] = [];

  for (const demand of countryPlan.demands) {
    if (demand.mobilisation_source === "province") continue;

    const mobTimePerUnit = unitMobTimeHours(demand.unitId, doctrine);
    if (mobTimePerUnit === 0) {
      // Zero mob time = launcher platform (e.g. cruise missile) — no flip point computation
      console.log(`  [${countryId}] skipping ${demand.unitId} (mob time = 0, launcher platform)`);
      continue;
    }

    // Account for batch_size (e.g. warheads produce 4 per mob event)
    const batchSize: number = (catalog.units[demand.unitId]?.levels?.["1"] as { batch_size?: number } | undefined)?.batch_size ?? 1;
    const effectiveCount = Math.ceil(demand.count / batchSize);

    for (let numCities = 1; numCities <= Math.min(maxCityCount, cityResults.length); numCities++) {
      for (let roLevel = 1; roLevel <= maxRoLevel; roLevel++) {
        const bonus = roSpeedBonus(roLevel);
        const mobWindow = computeMobWindow(effectiveCount, numCities, mobTimePerUnit, bonus);
        const requiredLevels = unitRequiredLevels(demand.unitId, roLevel);

        // Use the first numCities cities (sorted by capital-first, then by index)
        // This is a simplification — the harness reports per-configuration, not per-city
        const candidateCities = [...cityResults].sort((a, b) => (b.capital ? 1 : 0) - (a.capital ? 1 : 0));
        const assignedCities = candidateCities.slice(0, numCities);

        // Compute flip point for each assigned city (they share the mob window)
        const worstCity = assignedCities.reduce((worst, city) => {
          const fp = computeFlipPoint(city, requiredLevels, mobWindow, deadlineAbsHour, scenarioAbsHour, buildings);
          const prevFp = computeFlipPoint(worst, requiredLevels, mobWindow, deadlineAbsHour, scenarioAbsHour, buildings);
          return fp.flipPointRelHour < prevFp.flipPointRelHour ? city : worst;
        }, assignedCities[0]);

        if (!worstCity) continue;

        const fp = computeFlipPoint(worstCity, requiredLevels, mobWindow, deadlineAbsHour, scenarioAbsHour, buildings);

        const assignedCityIds = new Set(assignedCities.map(c => c.cityId));
        const ecoIncome = countryEcoBudget(cityResults, assignedCityIds, fp);
        const iCost = infraCostForChain(fp, numCities);
        const mCost = mobCostForDemand(demand.unitId, doctrine, effectiveCount);
        const uCost = upkeepCostForDemand(demand.unitId, doctrine, effectiveCount, Math.max(0, fp.mobilisationStartAbsHour - scenarioAbsHour));
        const netBalance = zeroResourceMap();
        for (const r of RESOURCE_KEYS) netBalance[r] = ecoIncome[r] - iCost[r] - mCost[r] - uCost[r];

        flipMatrixRows.push({
          unitId: demand.unitId,
          numCities,
          roLevel,
          mobWindowHours: Math.round(mobWindow),
          mobWindowDays: Math.round(mobWindow / 24 * 10) / 10,
          flipRelHour: Math.round(fp.flipPointRelHour),
          flipDay: fmtHour(Math.max(fp.flipPointRelHour, 0)),
          ecoHoursCaptured: Math.max(0, Math.round(fp.flipPointRelHour)),
          ecoBuildingsAtFlip: Object.entries(fp.ecoBuildingsAtFlip)
            .map(([k, v]) => `${k} L${v}`)
            .join(", ") || "(none)",
          remainingBuildHours: Math.round(fp.remainingBuildHours),
          remainingChain: fp.remainingChain.map(s => `${s.buildingId} L${s.fromLevel}→${s.toLevel} (${s.buildTimeHours}h)`).join(" → "),
          mobStartDay: fmtHour(Math.max(fp.mobilisationStartAbsHour - scenarioAbsHour, 0)),
          feasible: fp.feasible ? "✓" : "✗ (flip before start)",
          ecoIncome,
          infraCost: iCost,
          mobCost: mCost,
          upkeepCost: uCost,
          netBalance,
          affordable: formatNetBalance(netBalance),
        });
      }
    }
  }

  // Compute coalition contribution while cityResults is still in local scope (GC'd after return)
  const coalSelectedConfigs: SelectedConfig[] = [];
  const rowsForEco: Array<{ row: FlipMatrix }> = [];
  for (const demand of countryPlan.demands) {
    if (demand.mobilisation_source === "province") {
      coalSelectedConfigs.push({ demand, row: null, skipped: true });
      continue;
    }
    if (unitMobTimeHours(demand.unitId, doctrine) === 0) {
      coalSelectedConfigs.push({ demand, row: null, skipped: true });
      continue;
    }
    const best = selectBestRow(flipMatrixRows.filter(r => r.unitId === demand.unitId));
    coalSelectedConfigs.push({ demand, row: best, skipped: false });
    if (best) rowsForEco.push({ row: best });
  }
  const coEcoIncome = countryEcoIncomeForSelections(cityResults, rowsForEco);
  const coInfra = zeroResourceMap();
  const coMob = zeroResourceMap();
  const coUpkeep = zeroResourceMap();
  for (const cfg of coalSelectedConfigs) {
    if (!cfg.row) continue;
    addResources(coInfra, cfg.row.infraCost);
    addResources(coMob, cfg.row.mobCost);
    addResources(coUpkeep, cfg.row.upkeepCost);
  }
  const coNetBalance = zeroResourceMap();
  for (const r of RESOURCE_KEYS) coNetBalance[r] = coEcoIncome[r] - coInfra[r] - coMob[r] - coUpkeep[r];
  // Starting balance only applies when we are actively playing this country.
  const countryStartingBalance: Partial<Record<Resource, number>> =
    countryPlan.status === "homeland" ? (country.starting_balance ?? {}) : {};
  const manpowerNetBalance =
    coEcoIncome.manpower
    + (countryStartingBalance.manpower ?? 0)
    - coInfra.manpower - coMob.manpower - coUpkeep.manpower;
  const coalitionContribution: CountryCoalitionContribution = {
    countryId,
    countryName: country.country.name,
    doctrine,
    selectedConfigs: coalSelectedConfigs,
    ecoIncome: coEcoIncome,
    infraCost: coInfra,
    mobCost: coMob,
    upkeepCost: coUpkeep,
    netBalance: coNetBalance,
    countryStartingBalance,
    manpowerNetBalance,
    hasInfeasible: coalSelectedConfigs.some(c => !c.skipped && (c.row === null || c.row.feasible !== "✓")),
  };

  return {
    countryId,
    countryName: country.country.name,
    doctrine,
    status: countryPlan.status,
    demands: countryPlan.demands,
    ecoSummaries,
    flipMatrixRows,
    coalitionContribution,
  };
}

// ── Coalition aggregation ─────────────────────────────────────────────────────

type SelectedConfig = {
  demand: Demand;
  row: FlipMatrix | null;
  skipped: boolean; // launcher platform or province demand
};

type CountryCoalitionContribution = {
  countryId: string;
  countryName: string;
  doctrine: string;
  selectedConfigs: SelectedConfig[];
  ecoIncome: Record<Resource, number>;
  infraCost: Record<Resource, number>;
  mobCost: Record<Resource, number>;
  upkeepCost: Record<Resource, number>;
  netBalance: Record<Resource, number>;
  /** Per-country starting balance for pooled resources (zero for occupied/AI countries). */
  countryStartingBalance: Partial<Record<Resource, number>>;
  /** Manpower is not pooled: per-country check including country starting manpower. */
  manpowerNetBalance: number;
  hasInfeasible: boolean;
};

type CoalitionSummary = {
  countries: CountryCoalitionContribution[];
  totalEcoIncome: Record<Resource, number>;
  totalInfraCost: Record<Resource, number>;
  totalMobCost: Record<Resource, number>;
  totalUpkeepCost: Record<Resource, number>;
  /** Sum of per-country starting balances for pooled resources only (manpower excluded). */
  startingBalance: Record<Resource, number>;
  /** Net balance for pooled resources only; manpower stays zero here. */
  netCoalitionBalance: Record<Resource, number>;
};

function selectBestRow(rows: FlipMatrix[]): FlipMatrix | null {
  if (rows.length === 0) return null;
  const feasible = rows.filter(r => r.feasible === "✓");
  if (feasible.length > 0) {
    // Prefer most eco hours captured; break ties by fewest cities (cheaper infra)
    return feasible.slice().sort((a, b) =>
      b.ecoHoursCaptured - a.ecoHoursCaptured || a.numCities - b.numCities
    )[0];
  }
  // No feasible rows: pick the one with the smallest pooled shortfall
  return rows.slice().sort((a, b) => {
    const shortfall = (r: FlipMatrix) =>
      POOLED_RESOURCES.reduce((s, k) => s + Math.min(0, r.netBalance[k]), 0);
    return shortfall(b) - shortfall(a); // less negative = better
  })[0];
}

/**
 * Country eco income accounting for all demand city assignments.
 * Each city's flip point is the minimum across all demands that use it
 * (capital-first city ordering, same as analyseCountry).
 */
function countryEcoIncomeForSelections(
  cityResults: CityEcoResult[],
  selectedRows: Array<{ row: FlipMatrix }>,
): Record<Resource, number> {
  const sorted = [...cityResults].sort((a, b) => (b.capital ? 1 : 0) - (a.capital ? 1 : 0));
  // Map city index → earliest flip hour across all demands using that city
  const cityFlipMap = new Map<number, number>();
  for (const { row } of selectedRows) {
    for (let i = 0; i < row.numCities; i++) {
      const prev = cityFlipMap.get(i) ?? Infinity;
      cityFlipMap.set(i, Math.min(prev, row.flipRelHour));
    }
  }
  const total = zeroResourceMap();
  for (let i = 0; i < sorted.length; i++) {
    const city = sorted[i];
    const flip = cityFlipMap.get(i);
    addResources(total,
      flip !== undefined
        ? cityIncomeForConfig(city, Math.max(0, flip))
        : cityFullEcoIncome(city)
    );
  }
  return total;
}

function computeCoalitionSummary(analyses: CountryAnalysis[]): CoalitionSummary {
  // Starting balance: sum per-country values for pooled resources only.
  // Only homeland countries contribute (occupied/AI nations have no starting_balance).
  const startingBalance = zeroResourceMap();
  const totalEcoIncome = zeroResourceMap();
  const totalInfraCost = zeroResourceMap();
  const totalMobCost = zeroResourceMap();
  const totalUpkeepCost = zeroResourceMap();

  const countries: CountryCoalitionContribution[] = [];
  for (const analysis of analyses) {
    const contrib = analysis.coalitionContribution;
    for (const r of POOLED_RESOURCES) {
      startingBalance[r] += contrib.countryStartingBalance[r] ?? 0;
    }
    addResources(totalEcoIncome, contrib.ecoIncome);
    addResources(totalInfraCost, contrib.infraCost);
    addResources(totalMobCost, contrib.mobCost);
    addResources(totalUpkeepCost, contrib.upkeepCost);
    countries.push(contrib);
  }

  // Net coalition balance for pooled resources only; manpower stays zero.
  const netCoalitionBalance = zeroResourceMap();
  for (const r of POOLED_RESOURCES) {
    netCoalitionBalance[r] = totalEcoIncome[r] + startingBalance[r]
      - totalInfraCost[r] - totalMobCost[r] - totalUpkeepCost[r];
  }

  return {
    countries,
    totalEcoIncome,
    totalInfraCost,
    totalMobCost,
    totalUpkeepCost,
    startingBalance,
    netCoalitionBalance,
  };
}

// ── Run ───────────────────────────────────────────────────────────────────────

const countriesToAnalyse = countryFilter === "all"
  ? Object.keys(plan.countries)
  : [countryFilter];

const analyses: CountryAnalysis[] = [];
for (const countryId of countriesToAnalyse) {
  try {
    analyses.push(analyseCountry(countryId));
  } catch (err) {
    console.error(`[${countryId}] Error:`, err instanceof Error ? err.message : err);
  }
}

// ── HTML output ───────────────────────────────────────────────────────────────

function renderHtml(coalition: CoalitionSummary | null): string {
  const sections: string[] = [];
  sections.push(`<h1>Coalition Force Plan — Eco Flip-Point Analysis</h1>`);
  sections.push(htmlTable([{
    plan: plan.name,
    scenario: scenarioId,
    truce_days: plan.truce_days,
    scenarioStart: `abs hour ${scenarioAbsHour}`,
    deadline: `abs hour ${deadlineAbsHour} (${plan.truce_days * 24}h window)`,
    beamWidth,
    maxRoLevel,
    maxCityCount,
    "coalition starting balance": RESOURCE_KEYS
      .filter(r => (scenario.starting_balance?.[r] ?? 0) > 0)
      .map(r => `${r}:${(scenario.starting_balance?.[r] ?? 0).toLocaleString()}`)
      .join(" "),
  }]));

  // ── Coalition summary ──
  if (coalition) {
    sections.push(`<h2>Coalition Aggregation — Best-Pick Summary</h2>`);
    sections.push(`<p>For each country demand, the best feasible configuration is selected (most eco hours captured). ` +
      `Coalition eco income is computed per country accounting for all demand city assignments (per-city flip = earliest flip across demands using that city). ` +
      `Starting balance is summed from per-country values (homeland countries only; defined in each country YAML). ` +
      `Manpower is <strong>not pooled</strong> — checked per-country separately below. ` +
      `Costs exclude province demands (commando) and launcher platforms (cruise missile).</p>`);

    // Per-country selected configs
    const configRows: Array<Record<string, unknown>> = [];
    for (const c of coalition.countries) {
      const activeCfgs = c.selectedConfigs.filter(cfg => !cfg.skipped);
      if (activeCfgs.length === 0) {
        configRows.push({
          country: `${c.countryName} (${c.countryId})`,
          doctrine: c.doctrine,
          demand: "—",
          count: "—",
          "best config": "eco only",
          "flip day": "—",
          "eco hrs": "—",
          feasible: "N/A",
        });
      }
      for (const cfg of activeCfgs) {
        configRows.push({
          country: `${c.countryName} (${c.countryId})`,
          doctrine: c.doctrine,
          demand: cfg.demand.unitId,
          count: cfg.demand.count,
          "best config": cfg.row ? `${cfg.row.numCities}c RO${cfg.row.roLevel}` : "none",
          "flip day": cfg.row ? cfg.row.flipDay : "—",
          "eco hrs": cfg.row ? cfg.row.ecoHoursCaptured : "—",
          feasible: cfg.row ? cfg.row.feasible : "✗ (no rows)",
        });
      }
    }
    sections.push(htmlTable(configRows));

    // Per-country cost/income breakdown
    const fmt = (v: number) => v === 0 ? "0" : v > 0 ? `+${Math.round(v).toLocaleString()}` : `${Math.round(v).toLocaleString()}`;
    const resSummary = (rec: Record<Resource, number>) =>
      RESOURCE_KEYS.filter(k => Math.round(rec[k]) !== 0).map(k => `${k}:${Math.round(rec[k]).toLocaleString()}`).join(" ") || "—";
    const netSummary = (rec: Record<Resource, number>) =>
      RESOURCE_KEYS.filter(k => Math.round(rec[k]) !== 0).map(k => `${k}:${fmt(rec[k])}`).join(" ") || "balanced";

    sections.push(`<h3>Per-Country Income &amp; Cost Breakdown</h3>`);
    sections.push(htmlTable(coalition.countries.map(c => ({
      country: `${c.countryName} (${c.countryId})`,
      "⚠": c.hasInfeasible ? "⚠ infeasible demand" : "",
      "eco income (pooled)": POOLED_RESOURCES.filter(k => Math.round(c.ecoIncome[k]) !== 0).map(k => `${k}:${Math.round(c.ecoIncome[k]).toLocaleString()}`).join(" ") || "—",
      "infra cost": resSummary(c.infraCost),
      "mob cost (pooled)": POOLED_RESOURCES.filter(k => Math.round(c.mobCost[k]) !== 0).map(k => `${k}:${Math.round(c.mobCost[k]).toLocaleString()}`).join(" ") || "—",
      "upkeep cost (pooled)": POOLED_RESOURCES.filter(k => Math.round(c.upkeepCost[k]) !== 0).map(k => `${k}:${Math.round(c.upkeepCost[k]).toLocaleString()}`).join(" ") || "—",
      "net pooled (excl. starting)": POOLED_RESOURCES.filter(k => Math.round(c.netBalance[k]) !== 0).map(k => `${k}:${fmt(c.netBalance[k])}`).join(" ") || "balanced",
    }))));

    // Coalition balance sheet (pooled resources only — manpower handled per-country below)
    const grossAvailable = zeroResourceMap();
    for (const r of POOLED_RESOURCES) {
      grossAvailable[r] = coalition.totalEcoIncome[r] + coalition.startingBalance[r];
    }

    sections.push(`<h3>Coalition Balance Sheet (Pooled Resources)</h3>`);
    sections.push(htmlTable(
      [
        { line: "Total eco income", ...Object.fromEntries(POOLED_RESOURCES.map(r => [r, Math.round(coalition.totalEcoIncome[r]).toLocaleString()])) },
        { line: "+ Starting balance", ...Object.fromEntries(POOLED_RESOURCES.map(r => [r, Math.round(coalition.startingBalance[r]).toLocaleString()])) },
        { line: "= Gross available", ...Object.fromEntries(POOLED_RESOURCES.map(r => [r, Math.round(grossAvailable[r]).toLocaleString()])) },
        { line: "− Infra cost", ...Object.fromEntries(POOLED_RESOURCES.map(r => [r, Math.round(coalition.totalInfraCost[r]).toLocaleString()])) },
        { line: "− Mob cost", ...Object.fromEntries(POOLED_RESOURCES.map(r => [r, Math.round(coalition.totalMobCost[r]).toLocaleString()])) },
        { line: "− Upkeep cost", ...Object.fromEntries(POOLED_RESOURCES.map(r => [r, Math.round(coalition.totalUpkeepCost[r]).toLocaleString()])) },
        { line: "= Net coalition balance", ...Object.fromEntries(POOLED_RESOURCES.map(r => [r, fmt(coalition.netCoalitionBalance[r])])) },
      ]
    ));

    const shortfalls = POOLED_RESOURCES.filter(r => Math.round(coalition.netCoalitionBalance[r]) < 0);
    if (shortfalls.length === 0) {
      sections.push(`<p style="color:#1a7f37;font-weight:600">✓ Coalition pooled resources are affordable.</p>`);
    } else {
      sections.push(`<p style="color:#cf222e;font-weight:600">⚠ Shortfall in: ${shortfalls.map(r => `${r} (${Math.abs(Math.round(coalition.netCoalitionBalance[r])).toLocaleString()})`).join(", ")}</p>`);
    }

    // Per-country manpower check (manpower cannot be pooled)
    sections.push(`<h3>Manpower Check (Per-Country)</h3>`);
    sections.push(`<p>Manpower is country-specific and cannot be pooled. Each country must cover its own mobilisation and upkeep costs from its own eco income plus its own starting manpower balance.</p>`);
    sections.push(htmlTable(coalition.countries.map(c => {
      const net = Math.round(c.manpowerNetBalance);
      const status = net >= 0
        ? `✓ +${net.toLocaleString()}`
        : `⚠ ${net.toLocaleString()}`;
      return {
        country: `${c.countryName} (${c.countryId})`,
        "eco income": Math.round(c.ecoIncome.manpower).toLocaleString(),
        "mob cost": Math.round(c.mobCost.manpower).toLocaleString(),
        "upkeep cost": Math.round(c.upkeepCost.manpower).toLocaleString(),
        "starting": Math.round(c.countryStartingBalance.manpower ?? 0).toLocaleString(),
        "net": net.toLocaleString(),
        "status": status,
      };
    })));
  }

  for (const analysis of analyses) {
    sections.push(`<h2>${escapeHtml(analysis.countryName)} (${analysis.countryId}) — ${analysis.doctrine} / ${analysis.status}</h2>`);

    // Cities sorted capital-first (same ordering used for city assignment in the optimiser)
    const sortedCities = [...analysis.ecoSummaries]
      .sort((a, b) => (b.capital ? 1 : 0) - (a.capital ? 1 : 0));

    const activeCfgs = analysis.coalitionContribution.selectedConfigs.filter(c => !c.skipped && c.row);
    const provinceCfgs = analysis.coalitionContribution.selectedConfigs.filter(c => c.skipped && c.demand.mobilisation_source === "province");

    if (activeCfgs.length === 0) {
      // Eco-only country
      sections.push(`<h3>City Build Queues — Eco Only (no military demands)</h3>`);
      sections.push(htmlTable(sortedCities.map(c => ({
        city: (c.capital ? "★ " : "") + c.cityName,
        resource: c.resource,
        "eco sequence (full 28 days)": c.bestSequence,
      }))));
    } else {
      // Per-demand city plan
      for (const cfg of activeCfgs) {
        const row = cfg.row!;
        const { unitId, count } = cfg.demand;
        const cityRows = sortedCities.map((city, i) => {
          const isMilitary = i < row.numCities;
          return {
            city: (city.capital ? "★ " : "") + city.cityName,
            resource: city.resource,
            role: isMilitary ? "military" : "eco",
            "eco phase": isMilitary
              ? `${row.ecoBuildingsAtFlip} → flip ${row.flipDay}`
              : city.bestSequence,
            "military build chain": isMilitary
              ? `${row.remainingChain} (${row.remainingBuildHours}h)`
              : "—",
            "mob": isMilitary ? `→→→ from ${row.mobStartDay}` : "—",
          };
        });
        sections.push(`<h3>${escapeHtml(unitId)} × ${count} — ${row.numCities}c RO${row.roLevel} ` +
          `| flip ${row.flipDay} | build ${row.remainingBuildHours}h | mob from ${row.mobStartDay}</h3>`);
        sections.push(htmlTable(cityRows));
      }

      if (provinceCfgs.length > 0) {
        sections.push(`<p><em>Province mobilisation (not city-slotted): ` +
          provinceCfgs.map(c => `${c.demand.unitId} × ${c.demand.count}`).join(", ") +
          `</em></p>`);
      }
    }

    // Flip-point matrix collapsed for reference
    sections.push(`<details><summary style="cursor:pointer;color:#57606a;margin:8px 0">▶ Flip-Point Matrix — all configurations (${analysis.flipMatrixRows.length} rows)</summary>`);
    sections.push(htmlTable(analysis.flipMatrixRows.map(r => {
      const fmtV = (v: number) => v === 0 ? "0" : v > 0 ? `+${Math.round(v).toLocaleString()}` : `${Math.round(v).toLocaleString()}`;
      const resourceSummary = (rec: Record<Resource, number>) =>
        POOLED_RESOURCES.filter(k => Math.round(rec[k]) !== 0).map(k => `${k}:${Math.round(rec[k]).toLocaleString()}`).join(" ") || "—";
      return {
        unit: r.unitId,
        cities: r.numCities,
        "RO lv": r.roLevel,
        "flip day": r.flipDay,
        "eco hrs": r.ecoHoursCaptured,
        "eco bldgs at flip": r.ecoBuildingsAtFlip,
        "remaining build": `${r.remainingBuildHours}h`,
        "mob starts": r.mobStartDay,
        feasible: r.feasible,
        "eco income": resourceSummary(r.ecoIncome),
        "infra cost": resourceSummary(r.infraCost),
        "mob cost (pooled)": resourceSummary(r.mobCost),
        "net balance": POOLED_RESOURCES.filter(k => Math.round(r.netBalance[k]) !== 0).map(k => `${k}:${fmtV(r.netBalance[k])}`).join(" ") || "—",
      };
    })));
    sections.push(`</details>`);
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>Coalition Force Plan — Flip-Point Analysis</title><style>
body{font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.5;padding:24px;max-width:1800px;margin:0 auto}
table{border-collapse:collapse;width:100%;margin:12px 0 24px;font-size:13px}
th,td{border:1px solid #d0d7de;padding:6px 10px;vertical-align:top;text-align:left}
th{background:#f6f8fa;font-weight:600}

h1,h2,h3{margin:24px 0 8px}
h2{border-bottom:2px solid #d0d7de;padding-bottom:4px}
p{margin:4px 0 12px;color:#57606a}
details{margin:8px 0 24px}
details summary{font-size:13px;user-select:none}
</style></head><body>${sections.join("")}</body></html>`;
}

const coalition = countryFilter === "all" && analyses.length > 0
  ? computeCoalitionSummary(analyses)
  : null;

fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
fs.writeFileSync(outputFilePath, renderHtml(coalition), "utf8");
console.log(`\n[cfp] html written to ${outputFilePath}`);

// ── Terminal summary ──────────────────────────────────────────────────────────

for (const analysis of analyses) {
  console.log(`\n═══ ${analysis.countryName} (${analysis.doctrine}) ═══`);
  for (const s of analysis.ecoSummaries) {
    console.log(`  ${s.cityName} (${s.resource}${s.capital ? ", capital" : ""}): ${s.bestSequence.slice(0, 80)}`);
  }
  if (analysis.flipMatrixRows.length > 0) {
    console.log("\n  Flip-point matrix (unit / cities / RO → flip day / eco hrs captured):");
    for (const r of analysis.flipMatrixRows) {
      const tag = r.feasible === "✓" ? "" : " [INFEASIBLE]";
      console.log(`    ${r.unitId} | ${r.numCities}c RO${r.roLevel} | flip ${r.flipDay} | eco ${r.ecoHoursCaptured}h | mob window ${r.mobWindowHours}h${tag}`);
    }
  }
}
