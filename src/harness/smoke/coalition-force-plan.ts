import fs from "node:fs";
import path from "node:path";

import { scenarioStartAbsoluteHour } from "../../core/time.js";
import { durationToHours } from "../../engine/timing/activity-duration.js";
import { runCityEcoBeam } from "../../engine/eco/city-eco-beam.js";
import {
  computeFlipPoint,
  mobilisationWindowHours as computeMobWindow,
  requirementsToLevelMap,
} from "../../engine/eco/flip-point-solver.js";
import { loadBuildingsFile } from "../../scenarios/io/load-buildings.js";
import { loadScenarioCountry } from "../../scenarios/io/load-country.js";
import { loadScenarioCoalitionPlan } from "../../scenarios/io/load-coalition-plan.js";
import { loadScenarioFile } from "../../scenarios/io/load-scenario.js";
import { loadMergedUnitCatalogForScenario } from "../../scenarios/io/load-unit-catalog.js";
import type { CoalitionForcePlan, Demand } from "../../schemas/coalition-force-plan-schema.js";

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
};

type CountryAnalysis = {
  countryId: string;
  countryName: string;
  doctrine: string;
  status: string;
  demands: Demand[];
  ecoSummaries: CityEcoSummary[];
  flipMatrixRows: FlipMatrix[];
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
  });

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
        });
      }
    }
  }

  return {
    countryId,
    countryName: country.country.name,
    doctrine,
    status: countryPlan.status,
    demands: countryPlan.demands,
    ecoSummaries,
    flipMatrixRows,
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

function renderHtml(): string {
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

  for (const analysis of analyses) {
    sections.push(`<h2>${escapeHtml(analysis.countryName)} (${analysis.countryId}) — ${analysis.doctrine} / ${analysis.status}</h2>`);

    sections.push(`<h3>Demands</h3>`);
    sections.push(htmlTable(analysis.demands.map(d => ({
      unitId: d.unitId,
      count: d.count,
      mobilisation_source: d.mobilisation_source ?? "city",
    }))));

    sections.push(`<h3>City Eco Beam Results</h3>`);
    sections.push(htmlTable(analysis.ecoSummaries.map(s => ({
      city: s.cityName,
      resource: s.resource,
      capital: s.capital ? "yes" : "",
      explored: s.explored,
      best_eco_sequence: s.bestSequence,
    }))));

    sections.push(`<h3>Flip-Point Matrix (per unit × city count × RO level)</h3>`);
    sections.push(`<p>Each row: how early the city must stop eco-building to meet the mobilisation deadline.</p>`);
    sections.push(htmlTable(analysis.flipMatrixRows.map(r => ({
      unit: r.unitId,
      cities: r.numCities,
      "RO lv": r.roLevel,
      "mob window": `${r.mobWindowHours}h (${r.mobWindowDays}d)`,
      "flip day": r.flipDay,
      "eco hrs": r.ecoHoursCaptured,
      "eco bldgs at flip": r.ecoBuildingsAtFlip,
      "remaining build": `${r.remainingBuildHours}h`,
      "mob starts": r.mobStartDay,
      feasible: r.feasible,
    }))));
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>Coalition Force Plan — Flip-Point Analysis</title><style>
body{font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.5;padding:24px;max-width:1600px;margin:0 auto}
table{border-collapse:collapse;width:100%;margin:12px 0 24px;font-size:13px}
th,td{border:1px solid #d0d7de;padding:6px 10px;vertical-align:top;text-align:left}
th{background:#f6f8fa;font-weight:600}
h1,h2,h3{margin:24px 0 8px}
p{margin:4px 0 12px;color:#57606a}
</style></head><body>${sections.join("")}</body></html>`;
}

fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
fs.writeFileSync(outputFilePath, renderHtml(), "utf8");
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
