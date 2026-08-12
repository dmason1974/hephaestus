import fs from "node:fs";
import path from "node:path";

import type { Resource } from "../../core/constants.js";
import { POOLED_RESOURCES, PER_COUNTRY_RESOURCES } from "../../core/constants.js";
import { scenarioStartAbsoluteHour, toAbsoluteHour } from "../../core/time.js";
import { scenarioResearchUnlockedThroughDayAtStart } from "../../schemas/scenario-schema.js";
import { durationToHours } from "../../engine/timing/activity-duration.js";
import { runCityEcoBeam, type CityEcoResult } from "../../engine/eco/city-eco-beam.js";
import {
  zeroResourceMap,
  addResourcesInto,
  scaleResources,
  cityIncomeThroughFlip,
  cityFullEcoIncome,
} from "../../engine/eco/city-eco-income.js";
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
import { simulateUnitResearchTargets } from "../../engine/simulation/unit-research-sim.js";
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

function parseFormattedNumber(s: string): number {
  const trimmed = s.trim();
  if (trimmed.startsWith("+")) return parseFloat(trimmed.slice(1).replace(/,/g, "")) || 0;
  return parseFloat(trimmed.replace(/,/g, "")) || 0;
}

/** Renders a labelled balance sheet table where the net row has red/green coloured cells. */
function htmlBalanceSheet(
  rows: Array<Record<string, string>>,
  netRowLabel: string,
  resources: Resource[],
): string {
  const head = `<tr><th></th>${resources.map(r => `<th>${escapeHtml(r)}</th>`).join("")}</tr>`;
  const body = rows.map(row => {
    const isNet = row[""] === netRowLabel;
    const labelCell = `<td><strong>${escapeHtml(row[""])}</strong></td>`;
    const dataCells = resources.map(r => {
      const val = row[r] ?? "";
      if (isNet) {
        const n = parseFormattedNumber(val);
        const style = n < 0
          ? ` style="color:#cf222e;font-weight:600"`
          : n > 0 ? ` style="color:#1a7f37;font-weight:600"` : "";
        return `<td${style}>${escapeHtml(val)}</td>`;
      }
      return `<td>${escapeHtml(val)}</td>`;
    });
    return `<tr>${labelCell}${dataCells.join("")}</tr>`;
  }).join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

/**
 * Parses "air_base L2, arms_industry L5" → Map{air_base→2, arms_industry→5}.
 * ecoBuildingsAtFlip uses this format (worst-city eco state at flip point).
 */
function parseEcoBuildingsMap(ecoBuildingsAtFlip: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const m of ecoBuildingsAtFlip.matchAll(/(\w+) L(\d+)/g)) {
    map.set(m[1], parseInt(m[2], 10));
  }
  return map;
}

/**
 * Filters a city's timedOrderLines to only steps that completed before the flip point,
 * using the ecoBuildingsAtFlip map as the ground truth for what completed.
 */
function ecoStepsAtFlip(timedOrderLines: string[], ecoBuildingsAtFlip: string): string[] {
  const levelMap = parseEcoBuildingsMap(ecoBuildingsAtFlip);
  const kept = timedOrderLines.filter(line => {
    const m = line.match(/^\d+\. (\w+) level (\d+)/);
    if (!m) return false;
    return parseInt(m[2], 10) <= (levelMap.get(m[1]) ?? 0);
  });
  // Renumber to avoid gaps caused by filtered-out steps
  return kept.map((line, i) => line.replace(/^\d+\./, `${i + 1}.`));
}

/**
 * Builds a single readable build-sequence string for a military city:
 * eco steps (completed before flip) → flip marker → military chain steps.
 * Mob detail is shown separately in the mobilisation section.
 */
function militaryBuildSequence(
  timedOrderLines: string[],
  ecoBuildingsAtFlip: string,
  flipDay: string,
  remainingChain: string,
  remainingBuildHours: number,
): string {
  const lines: string[] = [
    ...ecoStepsAtFlip(timedOrderLines, ecoBuildingsAtFlip),
    `→ FLIP: ${flipDay}`,
  ];
  if (remainingChain) {
    for (const step of remainingChain.split(" → ")) lines.push(`  ${step}`);
    lines.push(`  (${remainingBuildHours}h build)`);
  }
  return lines.join("\n");
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

// ── Resource weights from force projection footprint ─────────────────────────

/**
 * Derives per-resource importance weights from the plan's demand footprint:
 *   weight[r] = Σ (mob_cost[r] × effectiveCount) + (daily_upkeep[r] × effectiveCount × truce_days)
 * Normalised so max = 1.0. Manpower is excluded (not pooled).
 * These weights guide the eco beam to invest in resources the force plan actually consumes.
 */
function computeForceProjectionWeights(): Partial<Record<Resource, number>> {
  const raw = zeroResourceMap();
  for (const [countryId, countryPlan] of Object.entries(plan.countries)) {
    let doctrine: string;
    try {
      doctrine = loadScenarioCountry(scenarioId, countryId).country.doctrine;
    } catch { continue; }
    for (const demand of countryPlan.demands) {
      if (demand.mobilisation_source === "province") continue;
      const unit = catalog.units[demand.unitId];
      if (!unit) continue;
      if (unitMobTimeHours(demand.unitId, doctrine) === 0) continue;
      const batchSize = (unit.levels?.["1"] as { batch_size?: number } | undefined)?.batch_size ?? 1;
      const effectiveCount = Math.ceil(demand.count / batchSize);
      const l1mob = unit.levels?.["1"]?.mobilisation as Record<string, { cost?: Partial<Record<Resource, number>> }> | undefined;
      const docMob = l1mob?.[doctrine] ?? Object.values(l1mob ?? {}).find(Boolean);
      if (docMob?.cost) {
        for (const r of RESOURCE_KEYS) raw[r] += (docMob.cost[r as Resource] ?? 0) * effectiveCount;
      }
      const l1upkeep = unit.levels?.["1"]?.daily_upkeep as Record<string, { cost?: Partial<Record<Resource, number>> }> | undefined;
      const docUpkeep = l1upkeep?.[doctrine] ?? Object.values(l1upkeep ?? {}).find(Boolean);
      if (docUpkeep?.cost) {
        for (const r of RESOURCE_KEYS) raw[r] += (docUpkeep.cost[r as Resource] ?? 0) * effectiveCount * plan.truce_days;
      }
    }
  }
  raw.manpower = 0; // manpower is not pooled — exclude from coalition eco scoring
  const maxVal = Math.max(...RESOURCE_KEYS.map(r => raw[r]));
  if (maxVal === 0) return {};
  const weights: Partial<Record<Resource, number>> = {};
  for (const r of RESOURCE_KEYS) {
    if (raw[r] > 0) weights[r] = raw[r] / maxVal;
  }
  return weights;
}

const resourceWeights = computeForceProjectionWeights();
console.log("[cfp] Force projection resource weights:",
  Object.entries(resourceWeights).map(([r, w]) => `${r}:${(w as number).toFixed(3)}`).join("  "));

// ── Income & cost accounting ──────────────────────────────────────────────────

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
      ? cityIncomeThroughFlip(city, Math.max(0, fp.flipPointRelHour), hoursToSimulate)
      : cityFullEcoIncome(city);
    addResourcesInto(total, cityContrib);
  }
  return total;
}

/** Cost of the military infra chain for one city × numCities. */
function infraCostForChain(fp: FlipPointResult, numCities: number): Record<Resource, number> {
  const total = zeroResourceMap();
  for (const step of fp.remainingChain) {
    const levelData = buildings.buildings[step.buildingId]?.levels[String(step.toLevel) as "1" | "2" | "3" | "4" | "5"];
    if (levelData?.cost) addResourcesInto(total, levelData.cost as Partial<Record<Resource, number>>);
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
  timedOrderLines: string[];
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

  // Occupied countries are assumed captured from start of game day 4.
  const captureAbsHour = countryPlan.status === "occupied" ? toAbsoluteHour(4, 0) : undefined;
  console.log(`\n[${countryId}] Running eco beam search for ${country.cities.length} cities${captureAbsHour !== undefined ? ` (captured day 4, captureRelHour=${captureAbsHour - scenarioAbsHour})` : ""}...`);
  const ecoResult = runCityEcoBeam(country, scenario, buildings, {
    hoursToSimulate,
    beamWidth,
    topN,
    resourceWeights,
  }, countryPlan.status as "homeland" | "occupied", undefined, captureAbsHour);

  const ecoSummaries: CityEcoSummary[] = ecoResult.cityResults.map(city => ({
    cityId: city.cityId,
    cityName: city.cityName,
    resource: city.resource,
    capital: city.capital,
    timedOrderLines: city.top[0]?.timedOrderLines ?? ["(no build)"],
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
  const coEcoBuildCost = zeroResourceMap();
  for (const city of cityResults) addResourcesInto(coEcoBuildCost, city.totalEcoBuildCost);
  const coInfra = zeroResourceMap();
  const coMob = zeroResourceMap();
  const coUpkeep = zeroResourceMap();
  for (const cfg of coalSelectedConfigs) {
    if (!cfg.row) continue;
    addResourcesInto(coInfra, cfg.row.infraCost);
    addResourcesInto(coMob, cfg.row.mobCost);
    addResourcesInto(coUpkeep, cfg.row.upkeepCost);
  }
  const coNetBalance = zeroResourceMap();
  for (const r of RESOURCE_KEYS) coNetBalance[r] = coEcoIncome[r] - coEcoBuildCost[r] - coInfra[r] - coMob[r] - coUpkeep[r];
  // Starting balance only applies when we are actively playing this country.
  const countryStartingBalance: Partial<Record<Resource, number>> =
    countryPlan.status === "homeland" ? (country.starting_balance ?? {}) : {};
  const manpowerNetBalance =
    coEcoIncome.manpower
    + (countryStartingBalance.manpower ?? 0)
    - coEcoBuildCost.manpower - coInfra.manpower - coMob.manpower - coUpkeep.manpower;
  const hourlyNetFlow = countryHourlyNetFlow(cityResults, rowsForEco, coalSelectedConfigs);
  const coalitionContribution: CountryCoalitionContribution = {
    countryId,
    countryName: country.country.name,
    doctrine,
    selectedConfigs: coalSelectedConfigs,
    ecoIncome: coEcoIncome,
    ecoBuildCost: coEcoBuildCost,
    infraCost: coInfra,
    mobCost: coMob,
    upkeepCost: coUpkeep,
    netBalance: coNetBalance,
    countryStartingBalance,
    manpowerNetBalance,
    hourlyNetFlow,
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
  /** Sum of eco building costs paid across all city eco beam sequences. */
  ecoBuildCost: Record<Resource, number>;
  /**
   * Per-hour net resource flow for this country (eco income - all costs).
   * Length = hoursToSimulate. Starting balance NOT included (added separately at coalition level).
   */
  hourlyNetFlow: Array<Record<Resource, number>>;
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
  totalEcoBuildCost: Record<Resource, number>;
  /** Net balance for pooled resources only; manpower stays zero here. */
  netCoalitionBalance: Record<Resource, number>;
  /** For each pooled resource: the hour at which the running balance is lowest, and its value. */
  resourceMinima: Partial<Record<Resource, { relHour: number; value: number }>>;
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
    addResourcesInto(total,
      flip !== undefined
        ? cityIncomeThroughFlip(city, Math.max(0, flip), hoursToSimulate)
        : cityFullEcoIncome(city)
    );
  }
  return total;
}

/**
 * Computes the per-hour net resource flow for a country:
 *   eco income (with flip-point caps) − eco build costs − infra costs (at flip) − mob costs − upkeep.
 * Starting balance is NOT included here — added at coalition level.
 */
function countryHourlyNetFlow(
  cityResults: CityEcoResult[],
  selectedRows: Array<{ row: FlipMatrix }>,
  selectedConfigs: SelectedConfig[],
): Array<Record<Resource, number>> {
  const flow = Array.from({ length: hoursToSimulate }, () => zeroResourceMap());

  // 1. Eco income with flip-point cap per city
  const sorted = [...cityResults].sort((a, b) => (b.capital ? 1 : 0) - (a.capital ? 1 : 0));
  const cityFlipMap = new Map<number, number>();
  for (const { row } of selectedRows) {
    for (let i = 0; i < row.numCities; i++) {
      const prev = cityFlipMap.get(i) ?? Infinity;
      cityFlipMap.set(i, Math.min(prev, row.flipRelHour));
    }
  }
  for (let i = 0; i < sorted.length; i++) {
    const city = sorted[i];
    const flipH = cityFlipMap.get(i);
    const flipIndex = flipH !== undefined ? Math.max(0, Math.round(flipH)) : Infinity;
    const flatRate = flipIndex < hoursToSimulate
      ? (city.hourlyCityProduction[Math.max(0, flipIndex - 1)] ?? zeroResourceMap())
      : null;
    for (let h = 0; h < hoursToSimulate; h++) {
      const prod = h < flipIndex
        ? (city.hourlyCityProduction[h] ?? zeroResourceMap())
        : (flatRate ?? zeroResourceMap());
      addResourcesInto(flow[h], prod);
    }
  }

  // 2. Eco build costs: one-time deduction at the action's scheduled start hour
  for (const city of cityResults) {
    for (const action of city.bestActions) {
      const h = Math.max(0, Math.min(Math.round(action.startHour ?? 0), hoursToSimulate - 1));
      const lvl = buildings.buildings[action.buildingId]?.levels[String(action.targetLevel) as "1" | "2" | "3" | "4" | "5"];
      if (lvl?.cost) {
        for (const r of RESOURCE_KEYS) flow[h][r] -= (lvl.cost as Partial<Record<Resource, number>>)[r] ?? 0;
      }
    }
  }

  // 3. Military costs from selected configs: infra at flip, mob at mob start, upkeep hourly
  for (const cfg of selectedConfigs) {
    if (!cfg.row) continue;
    const row = cfg.row;
    const flipH = Math.max(0, Math.min(Math.round(row.flipRelHour), hoursToSimulate - 1));
    const mobH = Math.max(0, Math.min(Math.round(row.flipRelHour + row.remainingBuildHours), hoursToSimulate - 1));
    const upkeepHours = hoursToSimulate - mobH;
    // Infra: lump at flip
    for (const r of RESOURCE_KEYS) flow[flipH][r] -= row.infraCost[r];
    // Mob: at mob start
    for (const r of RESOURCE_KEYS) flow[mobH][r] -= row.mobCost[r];
    // Upkeep: distribute evenly from mob start to deadline
    if (upkeepHours > 0) {
      for (let h = mobH; h < hoursToSimulate; h++) {
        for (const r of RESOURCE_KEYS) flow[h][r] -= row.upkeepCost[r] / upkeepHours;
      }
    }
  }

  return flow;
}

function computeCoalitionSummary(analyses: CountryAnalysis[]): CoalitionSummary {
  // Starting balance: sum per-country values for pooled resources only.
  // Only homeland countries contribute (occupied/AI nations have no starting_balance).
  const startingBalance = zeroResourceMap();
  const totalEcoIncome = zeroResourceMap();
  const totalEcoBuildCost = zeroResourceMap();
  const totalInfraCost = zeroResourceMap();
  const totalMobCost = zeroResourceMap();
  const totalUpkeepCost = zeroResourceMap();

  const countries: CountryCoalitionContribution[] = [];
  for (const analysis of analyses) {
    const contrib = analysis.coalitionContribution;
    for (const r of POOLED_RESOURCES) {
      startingBalance[r] += contrib.countryStartingBalance[r] ?? 0;
    }
    addResourcesInto(totalEcoIncome, contrib.ecoIncome);
    addResourcesInto(totalEcoBuildCost, contrib.ecoBuildCost);
    addResourcesInto(totalInfraCost, contrib.infraCost);
    addResourcesInto(totalMobCost, contrib.mobCost);
    addResourcesInto(totalUpkeepCost, contrib.upkeepCost);
    countries.push(contrib);
  }

  // Net coalition balance for pooled resources only; manpower stays zero.
  const netCoalitionBalance = zeroResourceMap();
  for (const r of POOLED_RESOURCES) {
    netCoalitionBalance[r] = totalEcoIncome[r] + startingBalance[r]
      - totalEcoBuildCost[r] - totalInfraCost[r] - totalMobCost[r] - totalUpkeepCost[r];
  }

  // Cash flow minima: aggregate hourly net flows, seed with starting balance at hour 0, find minimum.
  const coalitionHourlyFlow = Array.from({ length: hoursToSimulate }, () => zeroResourceMap());
  for (const contrib of countries) {
    for (let h = 0; h < hoursToSimulate; h++) {
      addResourcesInto(coalitionHourlyFlow[h], contrib.hourlyNetFlow[h]);
    }
  }
  // Seed hour 0 with the coalition starting balance (pooled resources only)
  for (const r of POOLED_RESOURCES) coalitionHourlyFlow[0][r] += startingBalance[r];

  // Compute running cumulative balance and find minimum per pooled resource
  const resourceMinima: CoalitionSummary["resourceMinima"] = {};
  const running = zeroResourceMap();
  for (let h = 0; h < hoursToSimulate; h++) {
    for (const r of POOLED_RESOURCES) {
      running[r] += coalitionHourlyFlow[h][r];
      if (running[r] < (resourceMinima[r]?.value ?? Infinity)) {
        resourceMinima[r] = { relHour: h, value: running[r] };
      }
    }
  }

  return {
    countries,
    totalEcoIncome,
    totalEcoBuildCost,
    totalInfraCost,
    totalMobCost,
    totalUpkeepCost,
    startingBalance,
    netCoalitionBalance,
    resourceMinima,
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

function renderHtml(coalition: CoalitionSummary | null, analysisSlice: CountryAnalysis[]): string {
  const fmt = (v: number) => v === 0 ? "0" : v > 0 ? `+${Math.round(v).toLocaleString()}` : `${Math.round(v).toLocaleString()}`;

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
  }]));

  // ── Coalition summary ──
  if (coalition) {
    sections.push(`<h2>Coalition Aggregation — Best-Pick Summary</h2>`);
    sections.push(`<p>For each country demand, the best feasible configuration is selected (most eco hours captured). ` +
      `Coalition eco income is computed per country accounting for all demand city assignments (per-city flip = earliest flip across demands using that city). ` +
      `Starting balance is summed from per-country values (homeland countries only). ` +
      `Costs exclude province demands (commando) and launcher platforms (cruise missile). ` +
      `Manpower is <strong>not pooled</strong> — detailed per country in the country sections below.</p>`);

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

    // Coalition balance sheet — pooled resources only, with coloured net row
    const grossAvailable = zeroResourceMap();
    for (const r of POOLED_RESOURCES) {
      grossAvailable[r] = coalition.totalEcoIncome[r] + coalition.startingBalance[r];
    }
    const balRows: Array<Record<string, string>> = [
      { "": "Total eco income (gross)", ...Object.fromEntries(POOLED_RESOURCES.map(r => [r, Math.round(coalition.totalEcoIncome[r]).toLocaleString()])) },
      { "": "+ Starting balance",       ...Object.fromEntries(POOLED_RESOURCES.map(r => [r, Math.round(coalition.startingBalance[r]).toLocaleString()])) },
      { "": "= Gross available",        ...Object.fromEntries(POOLED_RESOURCES.map(r => [r, Math.round(grossAvailable[r]).toLocaleString()])) },
      { "": "− Eco build costs",        ...Object.fromEntries(POOLED_RESOURCES.map(r => [r, Math.round(coalition.totalEcoBuildCost[r]).toLocaleString()])) },
      { "": "− Infra cost",             ...Object.fromEntries(POOLED_RESOURCES.map(r => [r, Math.round(coalition.totalInfraCost[r]).toLocaleString()])) },
      { "": "− Mob cost",               ...Object.fromEntries(POOLED_RESOURCES.map(r => [r, Math.round(coalition.totalMobCost[r]).toLocaleString()])) },
      { "": "− Upkeep cost",            ...Object.fromEntries(POOLED_RESOURCES.map(r => [r, Math.round(coalition.totalUpkeepCost[r]).toLocaleString()])) },
      { "": "= Net coalition balance",  ...Object.fromEntries(POOLED_RESOURCES.map(r => [r, fmt(coalition.netCoalitionBalance[r])])) },
    ];
    sections.push(`<h3>Coalition Balance Sheet (Pooled Resources)</h3>`);
    sections.push(htmlBalanceSheet(balRows, "= Net coalition balance", POOLED_RESOURCES));
    const shortfalls = POOLED_RESOURCES.filter(r => Math.round(coalition.netCoalitionBalance[r]) < 0);
    if (shortfalls.length === 0) {
      sections.push(`<p style="color:#1a7f37;font-weight:600">✓ Coalition pooled resources are affordable.</p>`);
    } else {
      sections.push(`<p style="color:#cf222e;font-weight:600">⚠ Shortfall in: ${shortfalls.map(r => `${r} (${Math.abs(Math.round(coalition.netCoalitionBalance[r])).toLocaleString()})`).join(", ")}</p>`);
    }

    // Eco income by country — columns ordered by resource_priority then cash + manpower
    const priorityResources: Resource[] = (plan.resource_priority ?? POOLED_RESOURCES) as Resource[];
    const ecoColOrder: Resource[] = [
      ...priorityResources,
      ...RESOURCE_KEYS.filter(r => !priorityResources.includes(r)),
    ];
    sections.push(`<h3>Coalition Eco Income by Country (Gross)</h3>`);
    sections.push(htmlTable(coalition.countries.map(c => ({
      country: `${c.countryName} (${c.countryId})`,
      status: c.doctrine + (c.selectedConfigs.every(cfg => cfg.skipped || !cfg.row) && c.selectedConfigs.length === 0 ? " / eco-only" : ""),
      ...Object.fromEntries(ecoColOrder.map(r => [r, Math.round(c.ecoIncome[r]).toLocaleString()])),
    }))));

    // Per-country net balance — resource columns in priority order (binding constraints leftmost)
    // All 7 resources shown; manpower labelled as not pooled
    sections.push(`<h3>Coalition Balance Sheet by Country</h3>`);
    sections.push(`<p><em>Net balance per country (eco income − eco build costs − infra − mob − upkeep + starting balance). ` +
      `Columns ordered by coalition resource priority. Manpower is <strong>not pooled</strong>.</em></p>`);
    const allResColOrder: Resource[] = [
      ...priorityResources,
      ...RESOURCE_KEYS.filter(r => !priorityResources.includes(r)),
    ];
    const countryNetRows: Array<Record<string, string>> = coalition.countries.map(c => {
      const row: Record<string, string> = {
        country: `${c.countryName} (${c.countryId})`,
      };
      for (const r of allResColOrder) {
        row[r === "manpower" ? "manpower (not pooled)" : r] = fmt(c.netBalance[r]);
      }
      return row;
    });
    // Custom render with red/green on all cells (not just net row)
    {
      const headers = Object.keys(countryNetRows[0] ?? {});
      const head = `<tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
      const body = countryNetRows.map(row =>
        `<tr>${headers.map(h => {
          const val = row[h] ?? "";
          const n = parseFormattedNumber(val);
          const isNum = h !== "country";
          const style = isNum && n < 0 ? ` style="color:#cf222e;font-weight:600"` : isNum && n > 0 ? ` style="color:#1a7f37;font-weight:600"` : "";
          return `<td${style}>${escapeHtml(val)}</td>`;
        }).join("")}</tr>`
      ).join("");
      sections.push(`<table><thead>${head}</thead><tbody>${body}</tbody></table>`);
    }

    // Cash flow minima: earliest hour any pooled resource goes negative
    sections.push(`<h3>Cash Flow — Resource Minima (Pooled)</h3>`);
    sections.push(`<p><em>Cumulative coalition balance by hour (starting balance + hourly net inflows − costs). ` +
      `Shows the nadir for each resource and when it occurs. Red = ever goes negative.</em></p>`);
    const minimaRows = POOLED_RESOURCES.map(r => {
      const m = coalition.resourceMinima[r];
      const neverNegative = !m || m.value >= 0;
      const valStr = m ? Math.round(m.value).toLocaleString() : "n/a";
      const whenStr = m ? fmtHour(m.relHour) : "—";
      return {
        resource: r,
        "minimum balance": neverNegative
          ? `+${Math.round(m?.value ?? 0).toLocaleString()}`
          : valStr,
        "nadir hour": whenStr,
        solvent: neverNegative ? "✓ always solvent" : "⚠ goes negative",
        _negative: !neverNegative,
      };
    });
    const minimaHeaders = ["resource", "minimum balance", "nadir hour", "solvent"];
    const minimaHead = `<tr>${minimaHeaders.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
    const minimaBody = minimaRows.map(row =>
      `<tr>${minimaHeaders.map(h => {
        const val = String(row[h as keyof typeof row] ?? "");
        const style = row._negative && h !== "resource"
          ? ` style="color:#cf222e;font-weight:600"`
          : !row._negative && h === "solvent"
            ? ` style="color:#1a7f37;font-weight:600"`
            : "";
        return `<td${style}>${escapeHtml(val)}</td>`;
      }).join("")}</tr>`
    ).join("");
    sections.push(`<table><thead>${minimaHead}</thead><tbody>${minimaBody}</tbody></table>`);
    const anyNegative = POOLED_RESOURCES.some(r => (coalition.resourceMinima[r]?.value ?? 0) < 0);
    if (!anyNegative) {
      sections.push(`<p style="color:#1a7f37;font-weight:600">✓ Coalition pooled resources never go negative during the plan horizon.</p>`);
    }
  }

  // ── Per-country sections ──
  if (!coalition) {
    for (const analysis of analysisSlice) {
      const c = analysis.coalitionContribution;
      const infeasibleTag = c.hasInfeasible ? ` <span style="color:#cf222e">⚠ infeasible demand</span>` : "";
      sections.push(`<h2>${escapeHtml(analysis.countryName)} (${analysis.countryId}) — ${analysis.doctrine} / ${analysis.status}${infeasibleTag}</h2>`);

      const sortedCities = [...analysis.ecoSummaries]
        .sort((a, b) => (b.capital ? 1 : 0) - (a.capital ? 1 : 0));

      const activeCfgs = analysis.coalitionContribution.selectedConfigs.filter(cfg => !cfg.skipped && cfg.row);
      const provinceCfgs = analysis.coalitionContribution.selectedConfigs.filter(cfg => cfg.skipped && cfg.demand.mobilisation_source === "province");

      if (activeCfgs.length === 0) {
        // 1. Demands
        sections.push(`<h3>Demands — Selected Configurations</h3>`);
        sections.push(`<p><em>No military demands — eco only.</em></p>`);
        if (provinceCfgs.length > 0) {
          sections.push(`<p><em>Province-mobilised (not city-slotted): ` +
            provinceCfgs.map(cfg => `${cfg.demand.unitId} × ${cfg.demand.count}`).join(", ") + `</em></p>`);
        }

        // 2. Country Balance Sheet
        {
          const gross = zeroResourceMap();
          for (const r of RESOURCE_KEYS) gross[r] = c.ecoIncome[r] + (c.countryStartingBalance[r] ?? 0);
          const net = zeroResourceMap();
          for (const r of RESOURCE_KEYS) net[r] = gross[r] - c.ecoBuildCost[r] - c.infraCost[r] - c.mobCost[r] - c.upkeepCost[r];
          sections.push(`<h3>Country Balance Sheet</h3>`);
          sections.push(`<p><em>Manpower (rightmost) is <strong>not pooled</strong> — country-specific. All other resources contribute to the coalition pool.</em></p>`);
          sections.push(htmlBalanceSheet([
            { "": "Eco income (gross)",  ...Object.fromEntries(RESOURCE_KEYS.map(r => [r, Math.round(c.ecoIncome[r]).toLocaleString()])) },
            { "": "+ Starting balance",  ...Object.fromEntries(RESOURCE_KEYS.map(r => [r, Math.round(c.countryStartingBalance[r] ?? 0).toLocaleString()])) },
            { "": "= Gross available",   ...Object.fromEntries(RESOURCE_KEYS.map(r => [r, Math.round(gross[r]).toLocaleString()])) },
            { "": "− Eco build costs",   ...Object.fromEntries(RESOURCE_KEYS.map(r => [r, Math.round(c.ecoBuildCost[r]).toLocaleString()])) },
            { "": "− Infra cost",        ...Object.fromEntries(RESOURCE_KEYS.map(r => [r, Math.round(c.infraCost[r]).toLocaleString()])) },
            { "": "− Mob cost",          ...Object.fromEntries(RESOURCE_KEYS.map(r => [r, Math.round(c.mobCost[r]).toLocaleString()])) },
            { "": "− Upkeep cost",       ...Object.fromEntries(RESOURCE_KEYS.map(r => [r, Math.round(c.upkeepCost[r]).toLocaleString()])) },
            { "": "= Net balance",       ...Object.fromEntries(RESOURCE_KEYS.map(r => [r, fmt(net[r])])) },
          ], "= Net balance", RESOURCE_KEYS));
        }

        // 3. Research Plan
        sections.push(`<h3>Research Plan</h3>`);
        sections.push(`<p><em>None — no military demands.</em></p>`);

        // 4. City Build Plans
        sections.push(`<h3>City Build Plans</h3>`);
        sections.push(`<p><em>Full eco build sequence for all ${plan.truce_days} days (eco only country).</em></p>`);
        sections.push(htmlTable(sortedCities.map(city => ({
          city: (city.capital ? "★ " : "") + city.cityName,
          resource: city.resource,
          "build sequence": city.timedOrderLines.join("\n"),
        }))));

        // 5. Mobilisation
        sections.push(`<h3>Mobilisation</h3>`);
        sections.push(`<p><em>None — no military demands.</em></p>`);

      } else {
        // 1. Demands summary
        sections.push(`<h3>Demands — Selected Configurations</h3>`);
        sections.push(htmlTable(activeCfgs.map(cfg => ({
          unit: cfg.demand.unitId,
          count: cfg.demand.count,
          config: cfg.row ? `${cfg.row.numCities}c RO${cfg.row.roLevel}` : "none",
          "flip day": cfg.row?.flipDay ?? "—",
          "eco hrs captured": cfg.row?.ecoHoursCaptured ?? "—",
          "mob start": cfg.row?.mobStartDay ?? "—",
          "mob window": cfg.row ? `${cfg.row.mobWindowDays}d (${cfg.row.mobWindowHours}h)` : "—",
          feasible: cfg.row?.feasible ?? "✗",
        }))));

        if (provinceCfgs.length > 0) {
          sections.push(`<p><em>Province-mobilised (not city-slotted): ` +
            provinceCfgs.map(cfg => `${cfg.demand.unitId} × ${cfg.demand.count}`).join(", ") + `</em></p>`);
        }

        // 2. Country balance sheet (right after demands)
        const gross = zeroResourceMap();
        for (const r of RESOURCE_KEYS) gross[r] = c.ecoIncome[r] + (c.countryStartingBalance[r] ?? 0);
        const net = zeroResourceMap();
        for (const r of RESOURCE_KEYS) net[r] = gross[r] - c.ecoBuildCost[r] - c.infraCost[r] - c.mobCost[r] - c.upkeepCost[r];

        sections.push(`<h3>Country Balance Sheet</h3>`);
        sections.push(`<p><em>Manpower (rightmost) is <strong>not pooled</strong> — country-specific. All other resources contribute to the coalition pool.</em></p>`);
        sections.push(htmlBalanceSheet([
          { "": "Eco income (gross)",  ...Object.fromEntries(RESOURCE_KEYS.map(r => [r, Math.round(c.ecoIncome[r]).toLocaleString()])) },
          { "": "+ Starting balance",  ...Object.fromEntries(RESOURCE_KEYS.map(r => [r, Math.round(c.countryStartingBalance[r] ?? 0).toLocaleString()])) },
          { "": "= Gross available",   ...Object.fromEntries(RESOURCE_KEYS.map(r => [r, Math.round(gross[r]).toLocaleString()])) },
          { "": "− Eco build costs",   ...Object.fromEntries(RESOURCE_KEYS.map(r => [r, Math.round(c.ecoBuildCost[r]).toLocaleString()])) },
          { "": "− Infra cost",        ...Object.fromEntries(RESOURCE_KEYS.map(r => [r, Math.round(c.infraCost[r]).toLocaleString()])) },
          { "": "− Mob cost",          ...Object.fromEntries(RESOURCE_KEYS.map(r => [r, Math.round(c.mobCost[r]).toLocaleString()])) },
          { "": "− Upkeep cost",       ...Object.fromEntries(RESOURCE_KEYS.map(r => [r, Math.round(c.upkeepCost[r]).toLocaleString()])) },
          { "": "= Net balance",       ...Object.fromEntries(RESOURCE_KEYS.map(r => [r, fmt(net[r])])) },
        ], "= Net balance", RESOURCE_KEYS));

        // 3. Research plan — L1 ASAP by constraining each L1 to its earliest possible completion
        const researchTargets: Record<string, number> = {};
        const latestCompletionByUnitLevel: Record<string, number> = {};
        const unlockedThrough = scenarioResearchUnlockedThroughDayAtStart(scenario);
        for (const cfg of activeCfgs) {
          const uid = cfg.demand.unitId;
          researchTargets[uid] = 1;
          const level1Research = catalog.units[uid]?.levels["1"]?.research[analysis.doctrine];
          if (level1Research) {
            const unlockDay = level1Research.unlock_day ?? 1;
            const effectiveUnlockDay = Math.max(1, unlockDay - unlockedThrough);
            const unlockAbsHour = effectiveUnlockDay <= scenario.start.day
              ? scenarioAbsHour
              : toAbsoluteHour(effectiveUnlockDay, 0);
            latestCompletionByUnitLevel[`${uid}:1`] = unlockAbsHour + Math.ceil(durationToHours(level1Research.time));
          }
        }
        const researchResult = simulateUnitResearchTargets(
          catalog,
          researchTargets,
          { ...scenario, truce_length_days: plan.truce_days },
          { enableJitScheduling: false, doctrine: analysis.doctrine, latestCompletionByUnitLevel },
        );
        sections.push(`<h3>Research Plan</h3>`);
        sections.push(`<p><em>L1 researched ASAP to unlock mobilisation; higher levels deferred JIT (not shown — depends on final level selection).</em></p>`);
        sections.push(htmlTable(
          researchResult.segments
            .sort((a, b) => a.slot - b.slot || a.startAbsoluteHour - b.startAbsoluteHour)
            .map(s => ({
              slot: `Slot ${s.slot}`,
              unit: s.unitId,
              level: s.level,
              start: fmtHour(s.startAbsoluteHour - scenarioAbsHour),
              complete: fmtHour(s.endAbsoluteHourExclusive - scenarioAbsHour),
              duration: `${s.durationHours}h`,
            }))
        ));

        // 4. Unified city build plan — one row per city, constraining-demand flip/chain
        // cityConstraint[i] = the selected config with the earliest flip that assigns city i
        const cityConstraint = new Map<number, FlipMatrix>();
        for (const cfg of activeCfgs) {
          const row = cfg.row!;
          for (let i = 0; i < row.numCities; i++) {
            const prev = cityConstraint.get(i);
            if (!prev || row.flipRelHour < prev.flipRelHour) cityConstraint.set(i, row);
          }
        }

        sections.push(`<h3>City Build Plans</h3>`);
        sections.push(`<p><em>Each military city shows eco builds completed before its flip point, then the military infra chain. ` +
          `Where multiple demands share a city, the earliest flip determines the shown sequence.</em></p>`);
        sections.push(htmlTable(sortedCities.map((city, i) => {
          const constraint = cityConstraint.get(i);
          return {
            city: (city.capital ? "★ " : "") + city.cityName,
            resource: city.resource,
            "build sequence": constraint
              ? militaryBuildSequence(
                  city.timedOrderLines,
                  constraint.ecoBuildingsAtFlip,
                  constraint.flipDay,
                  constraint.remainingChain,
                  constraint.remainingBuildHours,
                )
              : city.timedOrderLines.join("\n"),
          };
        })));

        // 5. Mobilisation — consolidated table, one row per city, one column per demand
        const mobCols = activeCfgs.map(cfg => {
          const row = cfg.row!;
          const dayStr = row.mobStartDay.match(/day \d+/)?.[0] ?? row.mobStartDay;
          return {
            label: `${cfg.demand.unitId} ×${cfg.demand.count} (${dayStr})`,
            numCities: row.numCities,
            perCity: Math.ceil(cfg.demand.count / row.numCities),
          };
        });

        sections.push(`<h3>Mobilisation</h3>`);
        sections.push(htmlTable(sortedCities.map((city, i) => {
          const row: Record<string, unknown> = {
            city: (city.capital ? "★ " : "") + city.cityName,
          };
          for (const col of mobCols) {
            row[col.label] = i < col.numCities ? `~${col.perCity}` : "—";
          }
          return row;
        })));
      }

    }
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>Coalition Force Plan — Flip-Point Analysis</title><style>
body{font-family:ui-monospace,"Cascadia Code","Fira Mono","Courier New",monospace;font-size:12px;line-height:1.5;padding:24px;max-width:1800px;margin:0 auto}
table{border-collapse:collapse;width:100%;margin:12px 0 24px;font-size:12px}
th,td{border:1px solid #d0d7de;padding:4px 8px;vertical-align:top;text-align:left;white-space:pre-wrap}
th{background:#f6f8fa;font-weight:600;font-size:11px}
h1,h2,h3,h4{margin:16px 0 6px}
h2{border-bottom:2px solid #d0d7de;padding-bottom:4px;margin-top:32px}
h3{margin-top:24px}
h4{font-size:13px;color:#24292f}
p{margin:4px 0 12px;color:#57606a}
details{margin:8px 0 24px}
details summary{font-size:12px;user-select:none}
</style></head><body>${sections.join("")}</body></html>`;
}

const coalition = countryFilter === "all" && analyses.length > 0
  ? computeCoalitionSummary(analyses)
  : null;

fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
fs.writeFileSync(outputFilePath, renderHtml(coalition, analyses), "utf8");
console.log(`\n[cfp] html written to ${outputFilePath}`);

if (countryFilter === "all") {
  const dir = path.dirname(outputFilePath);
  for (const analysis of analyses) {
    const countryPath = path.join(dir, `cfp-${analysis.countryId}.html`);
    fs.writeFileSync(countryPath, renderHtml(null, [analysis]), "utf8");
    console.log(`[cfp] country html → ${countryPath}`);
  }
}

// ── Terminal summary ──────────────────────────────────────────────────────────

for (const analysis of analyses) {
  console.log(`\n═══ ${analysis.countryName} (${analysis.doctrine}) ═══`);
  for (const s of analysis.ecoSummaries) {
    console.log(`  ${s.cityName} (${s.resource}${s.capital ? ", capital" : ""}): ${s.timedOrderLines.join(" → ").slice(0, 80)}`);
  }
  if (analysis.flipMatrixRows.length > 0) {
    console.log("\n  Flip-point matrix (unit / cities / RO → flip day / eco hrs captured):");
    for (const r of analysis.flipMatrixRows) {
      const tag = r.feasible === "✓" ? "" : " [INFEASIBLE]";
      console.log(`    ${r.unitId} | ${r.numCities}c RO${r.roLevel} | flip ${r.flipDay} | eco ${r.ecoHoursCaptured}h | mob window ${r.mobWindowHours}h${tag}`);
    }
  }
}
